/**
 * The reconciler process (§19, ticket 06).
 *
 * This is the lifecycle seam above the four individual loop suites. It proves
 * that a systemic failure escaping one loop is retried without taking its
 * siblings down, and that one shutdown signal releases every supervisor.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import {
  type AdapterRegistry,
  type Clock,
  systemClock,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import type { RepositoryHost } from '../../src/domain/repository.ts';
import {
  type ReconcilerProcessEvent,
  runReconciler,
  type SupervisedLoop,
  superviseLoops,
} from '../../src/reconciler/process.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('reconciler process lifecycle', () => {
  test('one failed loop retries without stopping its siblings', async () => {
    const shutdown = new AbortController();
    const failures: string[] = [];
    let healthyStarts = 0;
    let flakyStarts = 0;

    const loops: readonly SupervisedLoop[] = [
      {
        name: 'target',
        async run(signal) {
          healthyStarts += 1;
          await aborted(signal);
        },
      },
      {
        name: 'deploy',
        async run(signal) {
          flakyStarts += 1;
          if (flakyStarts === 1) throw new Error('database disconnected');
          shutdown.abort();
          await aborted(signal);
        },
      },
    ];

    await superviseLoops(loops, {
      signal: shutdown.signal,
      retry: { initialMs: 0, maximumMs: 0, multiplier: 2 },
      onFailure: ({ loop, cause }) => {
        failures.push(`${loop}: ${String(cause)}`);
      },
    });

    expect(healthyStarts).toBe(1);
    expect(flakyStarts).toBe(2);
    expect(failures).toEqual(['deploy: Error: database disconnected']);
  });

  test('an already-aborted process starts no loops', async () => {
    let starts = 0;
    await superviseLoops(
      [
        {
          name: 'config',
          async run() {
            starts += 1;
          },
        },
      ],
      { signal: AbortSignal.abort() },
    );
    expect(starts).toBe(0);
  });
});

describe('reconciler loop composition', () => {
  test('starts every configured polling loop and reports an absent repository integration', async () => {
    const adapters = createAdapterRegistry({
      manifest,
      env: {},
      token: async () => 'cluster-token',
      storeToken: () => 'store-token',
      buildToken: () => 'build-token',
      cloudToken: async () => 'cloud-token',
    });
    const shutdown = new AbortController();
    const events: ReconcilerProcessEvent[] = [];

    await runReconciler(
      {
        db: database().db,
        adapters,
        clock: systemClock,
        manifest,
      },
      {
        signal: shutdown.signal,
        onEvent(event) {
          events.push(event);
          const passed = new Set(
            events
              .filter((candidate) => candidate.type === 'pass')
              .map((candidate) => candidate.loop),
          );
          if (
            passed.has('target') &&
            passed.has('config') &&
            passed.has('deploy') &&
            events.some((candidate) => candidate.type === 'disabled')
          ) {
            shutdown.abort();
          }
        },
      },
    );

    expect(
      events
        .filter((event) => event.type === 'pass')
        .map((event) => event.loop)
        .sort(),
    ).toEqual(['config', 'deploy', 'target']);
    expect(events.find((event) => event.type === 'disabled')).toEqual({
      type: 'disabled',
      loop: 'repository',
      reason: 'this installation has no repository integration',
    });
  });

  test('starts repository polling when the installation has that integration', async () => {
    const configured = adaptersFor(new FakeDeployAdapter());
    const adapters: AdapterRegistry = {
      ...configured,
      repository: () => unusedRepositoryHost(),
    };
    const shutdown = new AbortController();
    const passed = new Set<string>();

    await runReconciler(
      { db: database().db, adapters, clock, manifest },
      {
        signal: shutdown.signal,
        onEvent(event) {
          if (event.type === 'pass') passed.add(event.loop);
          if (
            passed.has('target') &&
            passed.has('repository') &&
            passed.has('config') &&
            passed.has('deploy')
          ) {
            shutdown.abort();
          }
        },
      },
    );

    expect([...passed].sort()).toEqual([
      'config',
      'deploy',
      'repository',
      'target',
    ]);
  });
});

describe('Deploy convergence through process startup', () => {
  test('polling takes a pending Deploy to the platform’s successful verdict', async () => {
    const deploy = await pendingDeploy();
    const platform = new FakeDeployAdapter();
    const shutdown = new AbortController();

    await runReconciler(
      {
        db: database().db,
        adapters: adaptersFor(platform),
        clock,
        manifest,
      },
      {
        signal: shutdown.signal,
        onEvent(event) {
          if (event.type === 'pass' && event.loop === 'deploy') {
            shutdown.abort();
          }
        },
      },
    );

    const [stored] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, deploy.id));
    expect(stored?.phase).toBe('LIVE');
    expect(stored?.ref).toBe('fake-deploy-1');
    expect(platform.applied).toHaveLength(1);
  });

  test('polling persists the platform’s failed verdict', async () => {
    const deploy = await pendingDeploy();
    const platform = new FakeDeployAdapter({
      script: [
        {
          verdict: {
            phase: 'FAILED',
            reason: 'STARTUP_FAILED',
            detail: 'container exited before readiness',
          },
        },
      ],
    });
    const shutdown = new AbortController();

    await runReconciler(
      {
        db: database().db,
        adapters: adaptersFor(platform),
        clock,
        manifest,
      },
      {
        signal: shutdown.signal,
        onEvent(event) {
          if (event.type === 'pass' && event.loop === 'deploy') {
            shutdown.abort();
          }
        },
      },
    );

    const [stored] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, deploy.id));
    expect(stored?.phase).toBe('FAILED');
    expect(stored?.reason).toBe('STARTUP_FAILED');
    expect(stored?.detail).toBe('container exited before readiness');
    expect(stored?.blame).toBe('developer');
    expect(platform.applied).toHaveLength(1);
  });
});

function adaptersFor(platform: FakeDeployAdapter): AdapterRegistry {
  const configured = createAdapterRegistry({
    manifest,
    env: {},
    token: async () => 'cluster-token',
    storeToken: () => 'store-token',
    buildToken: () => 'build-token',
    cloudToken: async () => 'cloud-token',
  });
  return {
    ...configured,
    deploy: (adapter) =>
      adapter === platform.adapter ? platform : configured.deploy(adapter),
  };
}

/** An App, Component, Target, Build, and one PENDING Deploy intent. */
async function pendingDeploy() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: 'service',
      expose: true,
      exposure: 'private',
    })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cluster-${crypto.randomUUID()}`,
        adapter: 'kubernetes',
      }),
    )
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: DIGEST,
      status: 'SUCCEEDED',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      targetId: target!.id,
      buildId: build!.id,
      phase: 'PENDING',
      exposure: 'private',
    })
    .returning();
  return deploy!;
}

/** No repository rows exist in this lifecycle test, so no call lands here. */
function unusedRepositoryHost(): RepositoryHost {
  const unused = async (): Promise<never> => {
    throw new Error('an empty repository loop reached its far side');
  };
  return {
    repository: unused,
    branchHead: unused,
    readFile: unused,
    commitTree: unused,
    createBlob: unused,
    createTree: unused,
    createCommit: unused,
    setBranch: unused,
    openPullRequest: unused,
  };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
}
