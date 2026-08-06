/**
 * The reconciler process (§19, ticket 06).
 *
 * This is the lifecycle seam above the five individual loop suites. It proves
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
import type { InstallationManifest } from '../../src/config/manifest.schema.ts';
import { toAuthoredManifest } from '../../src/config/manifest.schema.ts';
import { MANIFEST_INLINE_VAR } from '../../src/config/manifest.ts';
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
const clock: Clock = { now: () => FROZEN };
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
    ).toEqual(['build', 'config', 'deploy', 'target']);
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
      'deploy',
      'repository',
      'target',
    ]);
  });
});

/**
 * Ticket 38 — the reconciler read the manifest once, at boot.
 *
 * `supplyChain.attestor` is the field that caught it: it was added through the
 * product's own authoring path, and the next Build still dispatched with the
 * empty value the process had booted with, so the attestation step skipped
 * itself and the artifact went out unattested with every step green. The row
 * is the seam — `configureInstallation` writes it and this asserts the
 * reconciler reads it again — so the write here is the store function that
 * command calls, without assembling a whole command context to reach it.
 */
describe('a manifest saved after boot', () => {
  test('reaches the loops without restarting the process', async () => {
    await pendingBuildNoRouteSatisfies();
    const shutdown = new AbortController();
    /** Every manifest handed to adapter assembly, in order. */
    const assembled: InstallationManifest[] = [];
    /** Which generation of adapters each build pass routed through. */
    const routedThrough: number[] = [];
    const ATTESTOR = 'projects/trusted-builds/attestors/spindrift';

    let written = false;
    await startReconciler({
      signal: shutdown.signal,
      client: database().connect(),
      clock,
      // Far below the 30s default so the change arrives inside a test.
      manifestIntervalMs: 5,
      env: {
        ...FIXTURE_DEPLOYMENT_ENV,
        [MANIFEST_INLINE_VAR]: JSON.stringify(toAuthoredManifest(manifest)),
      },
      createAdapters(storedManifest) {
        const generation = assembled.push(storedManifest);
        return {
          ...adaptersFor(new FakeDeployAdapter()),
          // `routeForTarget` asks this per pending Build, per pass, so which
          // generation answers says which manifest that pass ran against.
          // Answering `null` leaves the Build PENDING, which is what keeps
          // the build loop looking at it every idle interval.
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
          // The row `configureInstallation` writes, written the way it
          // writes it — without assembling a command context to reach it.
          await writeStoredManifest(database().db, {
            ...authored,
            supplyChain: { ...authored.supplyChain, attestor: ATTESTOR },
          });
          return;
        }

        // Stop once a build pass has routed through the rebuilt adapters —
        // the point being that a loop acted on the new manifest, not merely
        // that the row was re-read.
        if (routedThrough.includes(2)) shutdown.abort();
      },
    });

    // Assembled twice: once at boot, once when the document changed.
    expect(assembled).toHaveLength(2);
    expect(assembled[0]?.supplyChain.attestor).toBeUndefined();
    expect(assembled[1]?.supplyChain.attestor).toBe(ATTESTOR);
    // And a loop is running against the second one, with no restart between.
    expect(routedThrough).toContain(2);
    // Two build-loop idle intervals plus the change between them.
  }, 20_000);

  test('an unchanged document rebuilds nothing', async () => {
    const platform = new FakeDeployAdapter();
    const shutdown = new AbortController();
    const assembled: InstallationManifest[] = [];
    let manifestPasses = 0;

    await startReconciler({
      signal: shutdown.signal,
      client: database().connect(),
      clock,
      manifestIntervalMs: 5,
      env: {
        ...FIXTURE_DEPLOYMENT_ENV,
        [MANIFEST_INLINE_VAR]: JSON.stringify(toAuthoredManifest(manifest)),
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

    // Three re-reads, one assembly: the deep comparison is what keeps polling
    // affordable enough to do every 30 seconds.
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
  let bootManifest: unknown;
  await startReconciler({
    signal: shutdown.signal,
    client: database().connect(),
    clock,
    // The declaration and the deployment's own credential, which is how a pod
    // starts: the manifest names the installation, the mounted external_account
    // document names the federation, and the boot manifest is the two joined.
    env: {
      ...FIXTURE_DEPLOYMENT_ENV,
      [MANIFEST_INLINE_VAR]: JSON.stringify(toAuthoredManifest(manifest)),
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

/** An App, Component, Target, Build, and one PENDING Deploy intent. */
/**
 * A PENDING Build placed on a Target, for a registry whose `build()` answers
 * `null`.
 *
 * No route clears the Target's policy, so `runBuildPass` leaves it PENDING and
 * looks at it again every idle interval — which is what makes the build loop
 * observable more than once inside a test.
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
  await db.insert(builds).values({
    componentId: component!.id,
    commit: 'abcdef0',
    targetShape: 'image',
    artifactType: 'image',
    status: 'PENDING',
  });
}

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
    commitTree: unused,
    createBlob: unused,
    createTree: unused,
    createCommit: unused,
    setBranch: unused,
    openPullRequest: unused,
  };
}
