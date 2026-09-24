/**
 * The reconciler process: a failure escaping one loop is retried without
 * stopping its siblings, and one shutdown signal releases every supervisor.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import {
  type AdapterRegistry,
  type Clock,
  systemClock,
} from '../../src/commands/types.ts';
import type { InstallationManifest } from '../../src/config/manifest.schema.ts';
import { toAuthoredManifest } from '../../src/config/manifest.schema.ts';
import { writeStoredManifest } from '../../src/config/manifest-store.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import type { RepositoryHost } from '../../src/domain/repository.ts';
import {
  type ReconcilerProcessEvent,
  runReconciler,
} from '../../src/reconciler/process.ts';
import { startReconciler } from '../../src/reconciler/start.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  FIXTURE_DEPLOYMENT_ENV,
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const FROZEN = new Date('2024-06-01T00:00:00.000Z');
/**
 * Pinned to an instant and advancing at wall pace, so a refused Build's
 * dispatch backoff can expire between passes.
 */
const EPOCH = Date.now();
const clock: Clock = {
  now: () => new Date(FROZEN.getTime() + (Date.now() - EPOCH)),
};
const DIGEST = `sha256:${'a'.repeat(64)}`;

describe('reconciler process lifecycle', () => {
  test('one failed loop retries without stopping its siblings', async () => {
    const adapters = configuredAdapters();
    const shutdown = new AbortController();
    const passes = new Map<string, number>();
    const failures: Extract<ReconcilerProcessEvent, { type: 'failure' }>[] = [];

    await runReconciler(
      { db: database().db, adapters, clock, manifest },
      {
        signal: shutdown.signal,
        retry: { initialMs: 0, maximumMs: 0, multiplier: 2 },
        onEvent(event) {
          if (event.type === 'failure') failures.push(event);
          if (event.type !== 'pass') return;

          const count = (passes.get(event.loop) ?? 0) + 1;
          passes.set(event.loop, count);
          if (event.loop === 'target' && count === 1) {
            throw new Error('metrics sink disconnected');
          }
          if (
            (passes.get('target') ?? 0) === 2 &&
            passes.has('config') &&
            passes.has('datastore') &&
            passes.has('build') &&
            passes.has('deploy')
          ) {
            shutdown.abort();
          }
        },
      },
    );

    expect(passes.get('target')).toBe(2);
    expect(passes.get('config')).toBe(1);
    expect(passes.get('deploy')).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ type: 'failure', loop: 'target' });
    expect(String(failures[0]?.cause)).toBe('Error: metrics sink disconnected');
  });

  test('an already-aborted process starts no loops', async () => {
    const events: ReconcilerProcessEvent[] = [];
    await runReconciler(
      {
        db: database().db,
        adapters: configuredAdapters(),
        clock,
        manifest,
      },
      {
        signal: AbortSignal.abort(),
        onEvent: (event) => events.push(event),
      },
    );
    expect(events).toEqual([]);
  });
});

describe('reconciler loop composition', () => {
  test('starts every configured polling loop and reports an absent repository integration', async () => {
    const adapters = configuredAdapters();
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
            passed.has('datastore') &&
            passed.has('build') &&
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
    ).toEqual(['build', 'config', 'datastore', 'deploy', 'target', 'vessel']);
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
            passed.has('datastore') &&
            passed.has('build') &&
            passed.has('deploy')
          ) {
            shutdown.abort();
          }
        },
      },
    );

    expect([...passed].sort()).toEqual([
      'build',
      'config',
      'datastore',
      'deploy',
      'repository',
      'target',
      'vessel',
    ]);
  });
});

/**
 * The reconciler re-reads the stored manifest row and reassembles its adapters
 * when the document changes.
 */
describe('a manifest saved after boot', () => {
  test('reaches the loops without restarting the process', async () => {
    await pendingBuildNoRouteSatisfies();
    const shutdown = new AbortController();
    const assembled: InstallationManifest[] = [];
    /** Which generation of adapters each build pass routed through. */
    const routedThrough: number[] = [];
    const ATTESTOR = 'projects/trusted-builds/attestors/spindrift';

    let written = false;
    // A process boots from the stored manifest row, so seed one.
    await writeStoredManifest(database().db, toAuthoredManifest(manifest));
    await startReconciler({
      signal: shutdown.signal,
      client: database().connect(),
      clock,
      // Far below the 30s default so the change arrives inside a test.
      manifestIntervalMs: 5,
      env: {
        ...FIXTURE_DEPLOYMENT_ENV,
      },
      createAdapters(storedManifest) {
        const generation = assembled.push(storedManifest);
        return {
          ...adaptersFor(new FakeDeployAdapter()),
          // Asked per pending Build per pass, so the generation that answers
          // names the manifest that pass ran against. `null` keeps it PENDING.
          build: () => {
            routedThrough.push(generation);
            return null;
          },
        };
      },
      async onEvent(event) {
        if (event.type !== 'pass') return;

        if (event.loop === 'manifest' && !written) {
          written = true;
          const authored = toAuthoredManifest(manifest);
          // The same store write `configureInstallation` makes.
          await writeStoredManifest(database().db, {
            ...authored,
            supplyChain: { ...authored.supplyChain, attestor: ATTESTOR },
          });
          return;
        }

        // Stop once a build pass has routed through the rebuilt adapters.
        if (routedThrough.includes(2)) shutdown.abort();
      },
    });

    // Assembled twice: once at boot, once when the document changed.
    expect(assembled).toHaveLength(2);
    expect(assembled[0]?.supplyChain.attestor).toBeUndefined();
    expect(assembled[1]?.supplyChain.attestor).toBe(ATTESTOR);
    expect(routedThrough).toContain(2);
    // Two build-loop idle intervals plus the manifest change between them.
  }, 20_000);

  test('an unchanged document rebuilds nothing', async () => {
    const platform = new FakeDeployAdapter();
    const shutdown = new AbortController();
    const assembled: InstallationManifest[] = [];
    let manifestPasses = 0;

    await writeStoredManifest(database().db, toAuthoredManifest(manifest));
    await startReconciler({
      signal: shutdown.signal,
      client: database().connect(),
      clock,
      manifestIntervalMs: 5,
      env: {
        ...FIXTURE_DEPLOYMENT_ENV,
      },
      createAdapters(storedManifest) {
        assembled.push(storedManifest);
        return adaptersFor(platform);
      },
      onEvent(event) {
        if (event.type !== 'pass' || event.loop !== 'manifest') return;
        manifestPasses += 1;
        if (manifestPasses >= 3) shutdown.abort();
      },
    });

    // Three re-reads, one assembly: an unchanged document is not reassembled.
    expect(manifestPasses).toBeGreaterThanOrEqual(3);
    expect(assembled).toHaveLength(1);
  });
});

describe('Deploy convergence through process startup', () => {
  test('polling takes a pending Deploy to the platform’s successful verdict', async () => {
    const platform = new FakeDeployAdapter();
    const { stored, bootManifest } = await reconcilePendingDeploy(platform);
    expect(stored?.phase).toBe('LIVE');
    expect(stored?.ref).toBe('fake-deploy-1');
    expect(platform.applied).toHaveLength(1);
    expect(bootManifest).toEqual(manifest);
  });

  test('polling persists the platform’s failed verdict', async () => {
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
    const { stored, bootManifest } = await reconcilePendingDeploy(platform);
    expect(stored?.phase).toBe('FAILED');
    expect(stored?.reason).toBe('STARTUP_FAILED');
    expect(stored?.detail).toBe('container exited before readiness');
    expect(stored?.blame).toBe('developer');
    expect(platform.applied).toHaveLength(1);
    expect(bootManifest).toEqual(manifest);
  });
});

function adaptersFor(platform: FakeDeployAdapter): AdapterRegistry {
  const configured = configuredAdapters();
  return {
    ...configured,
    deploy: (adapter) =>
      adapter === platform.adapter ? platform : configured.deploy(adapter),
  };
}

function configuredAdapters(): AdapterRegistry {
  return createAdapterRegistry({
    manifest,
    env: {},
    token: async () => 'cluster-token',
    storeToken: () => 'store-token',
    cloudToken: async () => 'cloud-token',
  });
}

async function reconcilePendingDeploy(platform: FakeDeployAdapter) {
  const deploy = await pendingDeploy();
  const shutdown = new AbortController();
  await writeStoredManifest(database().db, toAuthoredManifest(manifest));
  let bootManifest: unknown;
  await startReconciler({
    signal: shutdown.signal,
    client: database().connect(),
    clock,
    // The boot manifest joins the stored row with the federation the mounted
    // credential names.
    env: {
      ...FIXTURE_DEPLOYMENT_ENV,
    },
    createAdapters(storedManifest) {
      bootManifest = storedManifest;
      return adaptersFor(platform);
    },
    onEvent(event) {
      if (event.type === 'pass' && event.loop === 'deploy') shutdown.abort();
    },
  });
  const [stored] = await database()
    .db.select()
    .from(deploys)
    .where(eq(deploys.id, deploy.id));
  return { stored, bootManifest };
}

/**
 * A PENDING Build placed on a Target. With `build()` answering `null` no route
 * is configured, so the build loop sees it again every idle interval.
 */
async function pendingBuildNoRouteSatisfies() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, adapter: 'kubernetes' }))
    .returning();
  await db
    .insert(componentTargetDesired)
    .values({ componentId: component!.id, targetId: target!.id });
  await db
    .update(components)
    .set({ placedTargetId: target!.id })
    .where(eq(components.id, component!.id));
  await db.insert(builds).values({
    componentId: component!.id,
    commit: 'abcdef0',
    targetShape: 'image',
    artifactType: 'image',
    status: 'PENDING',
  });
}

/** An App, Component, Target, succeeded Build and one PENDING Deploy. */
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
      reach: 'private',
      auth: 'proxy',
    })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, adapter: 'kubernetes' }))
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
      desired: aDesiredDocument({ reach: 'private', auth: 'proxy' }),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'PENDING',
    })
    .returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
    desiredBuildId: build!.id,
    desiredDeployId: deploy!.id,
  });
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
    treePaths: unused,
    pullRequestState: unused,
    commitTree: unused,
    createBlob: unused,
    createTree: unused,
    createCommit: unused,
    setBranch: unused,
    openPullRequest: unused,
  };
}
