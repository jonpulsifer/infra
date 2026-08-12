/**
 * A Component's own entrypoint: one image run several ways (119, §2, §7).
 *
 * The chart has taken `app.command` and `app.args` since it was written and
 * Cloud Run's container carries the same two fields; core never sent either, so
 * `web`, `worker` and `cleanup` off one monolith were three images or nothing.
 * Four claims here:
 *
 * - **Two Components off the same image differ by the entrypoint and by
 *   nothing else.** Same digest on both releases, different `command` in the
 *   values each is applied with. This is the whole feature: if it failed, the
 *   two would be indistinguishable workloads.
 * - **Absent means the image's own, on both adapters.** A Component that states
 *   no entrypoint renders `[]` for the chart — which its `with` skips exactly
 *   as it skips an absent key — and nothing at all in a Cloud Run container,
 *   because a rendered empty `command` there reads as "run no command".
 * - **A non-null entrypoint round-trips through `deploys.desired`.** The
 *   document is what `desiredStateFor` replays, so the pin is what an attempt
 *   actually applies, not the Component row.
 * - **The pin survives a later edit, and a rollback does not yet read it.**
 *   Both halves asserted, because 119 claims the second and core does not do
 *   it: `rollbackDeploy` restores `config` from history and composes the rest
 *   of the document from the Component as it is today. The last describe block
 *   states which one is true and where a fix would show up.
 */
import { describe, expect, test } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { workloadContainer } from '../../src/adapters/deploy/cloudrun/service.ts';
import { appValues } from '../../src/adapters/deploy/kubernetes/values.ts';
import {
  setComponentCommand,
  setComponentCommandInput,
} from '../../src/commands/components/command.ts';
import { createDeploy, rollbackDeploy } from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { targetLabel } from '../../src/domain/target.ts';
import {
  type DeployLoopContext,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

/**
 * The one image every Build in this file produces.
 *
 * Shared deliberately: 119's case is a monolith, where the artifact is
 * byte-identical across Components and the entrypoint is the only thing that
 * tells the workloads apart. Builds are Component-scoped
 * (`src/db/schema.ts`), so "one image" is one digest under several Build rows
 * rather than one row — which is the redundancy 120 removes, not this test's
 * subject.
 */
const DIGEST = `sha256:${'a'.repeat(64)}`;

function registryOf(deployAdapter: FakeDeployAdapter): AdapterRegistry {
  const chain = new SupplyChainHarness();
  return {
    deploy: (adapter) =>
      adapter === deployAdapter.adapter ? deployAdapter : null,
    build: () => {
      throw new Error('an entrypoint edit must not reach a builder');
    },
    store: () => {
      throw new Error('an entrypoint edit must not reach the secret store');
    },
    repository: () => null,
    supplyChain: () => chain,
  };
}

function context(adapters: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

function loopContext(adapter: FakeDeployAdapter): DeployLoopContext {
  return {
    db: database().db,
    adapters: { deploy: (name) => (name === adapter.adapter ? adapter : null) },
    clock,
    manifest,
  };
}

/** One App and one Kubernetes Target; Components are added per test. */
async function fixture() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'monolith', sourceKind: 'repo' })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', {
    name: `folly-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        adapter: 'kubernetes',
        vesselId: vessel.id,
        discovery: null,
      }),
    )
    .returning();
  return {
    app: app!,
    target: target!,
    label: targetLabel({ vessel: vessel.name, adapter: 'kubernetes' }),
  };
}

/** A Component of the App, with whatever entrypoint it declares at creation. */
async function component(
  appId: string,
  name: string,
  entrypoint: { command?: string[]; args?: string[] } = {},
) {
  const [row] = await database()
    .db.insert(components)
    .values({
      appId,
      name,
      kind: 'service',
      expose: name === 'web',
      reach: 'none',
      auth: 'none',
      command: entrypoint.command ?? null,
      args: entrypoint.args ?? null,
    })
    .returning();
  return row!;
}

/** A `SUCCEEDED` Build of the shared image, at the given commit. */
async function build(componentId: string, commit: string) {
  const [row] = await database()
    .db.insert(builds)
    .values({
      componentId,
      commit,
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: DIGEST,
      bundleDigest: DIGEST,
      bundleLocation: `https://depot.example.test/bundles/${commit}.zip`,
      status: 'SUCCEEDED',
      verifiedBuildLevel: 2,
      signature: testSignature(DIGEST, FROZEN.toISOString()),
    })
    .returning();
  return row!;
}

/** Ship one Build to the Target and run the loop to a verdict. */
async function ship(
  adapters: AdapterRegistry,
  adapter: FakeDeployAdapter,
  componentId: string,
  targetId: string,
  buildId: number,
) {
  const placed = await createDeploy(
    { componentId, targetId, buildId },
    context(adapters),
  );
  expect(placed.ok).toBe(true);
  await runDeployPass(loopContext(adapter));
  return placed;
}

describe('one image, two Components, two entrypoints', () => {
  test('the same digest is applied twice under different commands', async () => {
    const { app, target } = await fixture();
    const web = await component(app.id, 'web', {
      command: ['/app/bin/server'],
      args: ['--port', '8080'],
    });
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
      args: ['--queue', 'default'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await ship(
      adapters,
      adapter,
      web.id,
      target.id,
      (await build(web.id, 'abcdef0')).id,
    );
    await ship(
      adapters,
      adapter,
      worker.id,
      target.id,
      (await build(worker.id, 'abcdef0')).id,
    );

    expect(adapter.applied).toHaveLength(2);
    // The artifact is the same one — the premise, not the claim.
    expect(
      adapter.applied.map(({ desired }) => desired.artifact.digest),
    ).toEqual([DIGEST, DIGEST]);
    // The claim: the entrypoint is what the two releases disagree about, and it
    // survives all the way into the values the chart is applied with.
    const rendered = adapter.applied.map(({ desired }) =>
      appValues(desired, `ghcr.io/example/monolith@${DIGEST}`),
    );
    expect(rendered.map((values) => values.command)).toEqual([
      ['/app/bin/server'],
      ['/app/bin/worker'],
    ]);
    expect(rendered.map((values) => values.args)).toEqual([
      ['--port', '8080'],
      ['--queue', 'default'],
    ]);
    expect(rendered.map((values) => values.image)).toEqual([
      `ghcr.io/example/monolith@${DIGEST}`,
      `ghcr.io/example/monolith@${DIGEST}`,
    ]);
  });

  test('a Component that states no entrypoint renders the image’s own', async () => {
    const { app, target } = await fixture();
    const plain = await component(app.id, 'web');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);

    await ship(
      adapters,
      adapter,
      plain.id,
      target.id,
      (await build(plain.id, 'abcdef0')).id,
    );

    const desired = adapter.applied[0]!.desired;
    // Absent in the document, not null: the pin carries what the row said, and
    // `null` on the row is a statement the document spells as silence.
    expect(desired.command).toBeUndefined();
    expect(desired.args).toBeUndefined();
    // `[]` in the values, because the chart's `podSpec` wraps each key in a
    // `with` — an empty list is skipped exactly as an absent one would be, and
    // a key the chart has always declared is cheaper to always write than to
    // conditionally omit.
    const values = appValues(desired, `ghcr.io/example/monolith@${DIGEST}`);
    expect(values.command).toEqual([]);
    expect(values.args).toEqual([]);
  });

  test('the Cloud Run container carries the same entrypoint, or none', async () => {
    const { app, target } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
      args: ['--queue', 'default'],
    });
    const plain = await component(app.id, 'web');
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    await ship(
      adapters,
      adapter,
      worker.id,
      target.id,
      (await build(worker.id, 'abcdef0')).id,
    );
    await ship(
      adapters,
      adapter,
      plain.id,
      target.id,
      (await build(plain.id, 'abcdef0')).id,
    );

    // Rendered off the same neutral documents the Kubernetes path just used —
    // the point being that a field one adapter honours is not silently dropped
    // by the other. A Component's entrypoint must not depend on where it lands.
    const renderContext = {
      project: 'bluenose',
      image: `ghcr.io/example/monolith@${DIGEST}`,
      serviceAccount: null,
      useProjectAdmissionPolicy: false,
    };
    const stated = workloadContainer(
      adapter.applied[0]!.desired,
      renderContext,
    );
    expect(stated.command).toEqual(['/app/bin/worker']);
    expect(stated.args).toEqual(['--queue', 'default']);

    // Absent rather than `[]` here, unlike the chart: the runtime reads a
    // rendered empty `command` as an override that runs nothing, so the only
    // way to say "the image's own" is to say nothing.
    const own = workloadContainer(adapter.applied[1]!.desired, renderContext);
    expect(own).not.toHaveProperty('command');
    expect(own).not.toHaveProperty('args');
  });
});

describe('the edit writes a Component and leaves a Deploy to be pressed', () => {
  test('a Target running the old entrypoint is named; nothing is applied', async () => {
    const { app, target, label } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    await ship(
      adapters,
      adapter,
      worker.id,
      target.id,
      (await build(worker.id, 'abcdef0')).id,
    );

    const edited = await setComponentCommand(
      { componentId: worker.id, command: ['/app/bin/cleanup'], args: null },
      context(adapters),
    );

    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.value.command).toEqual(['/app/bin/cleanup']);
    expect(edited.value.args).toBeNull();
    expect(edited.value.pendingRelease).toEqual([label]);
    // The row changed and the platform was not asked for anything. A second
    // `apply` here would be this command re-placing a live release nobody
    // pressed Deploy for.
    expect(adapter.applied).toHaveLength(1);
    const [row] = await database()
      .db.select()
      .from(components)
      .where(eq(components.id, worker.id));
    expect(row?.command).toEqual(['/app/bin/cleanup']);
    expect(row?.updatedAt).toEqual(FROZEN);
  });

  test('a Target whose live release already runs it is not pending', async () => {
    const { app, target } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
      args: ['--queue', 'default'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    await ship(
      adapters,
      adapter,
      worker.id,
      target.id,
      (await build(worker.id, 'abcdef0')).id,
    );

    // Saying again exactly what is already released. The pin is what lets this
    // be distinguished from a change — `setComponentSchedule` has no such pin
    // to read and so names every placed Target unconditionally.
    const same = await setComponentCommand(
      {
        componentId: worker.id,
        command: ['/app/bin/worker'],
        args: ['--queue', 'default'],
      },
      context(adapters),
    );

    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.value.pendingRelease).toEqual([]);
  });

  test('an unknown Component is a refusal with an identity', async () => {
    const missing = crypto.randomUUID();

    const result = await setComponentCommand(
      { componentId: missing, command: null, args: null },
      context(registryOf(new FakeDeployAdapter())),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_FOUND');
    expect(result.failure.message).toContain(missing);
  });

  test('an empty argv is refused: `null` is the one spelling for the image’s own', () => {
    const parsed = setComponentCommandInput.safeParse({
      componentId: crypto.randomUUID(),
      command: [],
      args: null,
    });

    expect(parsed.success).toBe(false);
  });
});

describe('the entrypoint round-trips through the pinned document', () => {
  test('an edit then a Deploy hands the adapter the new entrypoint', async () => {
    const { app, target } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    const created = await build(worker.id, 'abcdef0');
    await ship(adapters, adapter, worker.id, target.id, created.id);
    expect(adapter.applied[0]?.desired.command).toEqual(['/app/bin/worker']);

    const edited = await setComponentCommand(
      {
        componentId: worker.id,
        command: ['/app/bin/cleanup'],
        args: ['--all'],
      },
      context(adapters),
    );
    expect(edited.ok).toBe(true);
    await ship(adapters, adapter, worker.id, target.id, created.id);

    expect(adapter.applied).toHaveLength(2);
    expect(adapter.applied[1]?.desired.command).toEqual(['/app/bin/cleanup']);
    expect(adapter.applied[1]?.desired.args).toEqual(['--all']);
    // And it is on the row the loop replayed, not re-read from `components`:
    // `desiredStateFor` spreads `deploy.desired`, so what is stored is what is
    // applied. A pin that did not hold the entrypoint would leave this null.
    const [newest] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, worker.id))
      .orderBy(desc(deploys.id))
      .limit(1);
    expect(newest?.desired.command).toEqual(['/app/bin/cleanup']);
    expect(newest?.desired.args).toEqual(['--all']);
  });

  test('removing the entrypoint and pressing Deploy applies the image’s own', async () => {
    const { app, target } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
      args: ['--queue', 'default'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    const created = await build(worker.id, 'abcdef0');
    await ship(adapters, adapter, worker.id, target.id, created.id);

    const cleared = await setComponentCommand(
      { componentId: worker.id, command: null, args: null },
      context(adapters),
    );
    expect(cleared.ok).toBe(true);
    await ship(adapters, adapter, worker.id, target.id, created.id);

    // The removal branch: `command` was write-once at creation until this
    // command existed, so no caller could ever produce a re-deploy whose
    // entrypoint differed from the one the Component was created with.
    expect(adapter.applied[1]?.desired.command).toBeUndefined();
    expect(adapter.applied[1]?.desired.args).toBeUndefined();
    expect(
      appValues(adapter.applied[1]!.desired, 'x@sha256:1').command,
    ).toEqual([]);
  });
});

describe('a rollback and the entrypoint the older release ran with', () => {
  /**
   * **What the pin guarantees, and what it does not.**
   *
   * 119 says a rollback "restores the entrypoint that release ran with", on the
   * grounds that `DesiredDocument` pins it. The pin is real and this test
   * asserts it: the older Deploy row still names the entrypoint it shipped, and
   * `desiredStateFor` replays that document rather than re-reading `components`
   * — so re-running that intent applies the old entrypoint, forever.
   *
   * What a rollback does is a different act. `rollbackDeploy` writes a **new**
   * intent through the ordinary `checkDeployable` path and overrides exactly one
   * field of it from history — `config`, because §10 states that claim
   * explicitly (`src/commands/deploys/rollback.ts:57-71`). Everything else in
   * the new document is composed from the Component as it is today, which is
   * equally true of `reach`, `auth`, `expose` and `schedule`.
   *
   * So the honest statement is that the entrypoint is pinned per release and a
   * rollback does not yet read the pin. Both halves are asserted below, because
   * the second is the one a future change would flip and this is where it
   * should go red when somebody makes rollback replay the whole document.
   */
  test('the older release keeps its entrypoint; the rollback places today’s', async () => {
    const { app, target } = await fixture();
    const worker = await component(app.id, 'worker', {
      command: ['/app/bin/worker'],
    });
    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    const older = await build(worker.id, 'abcdef0');
    const newer = await build(worker.id, 'bcdef01');

    const first = await ship(adapters, adapter, worker.id, target.id, older.id);
    const edited = await setComponentCommand(
      { componentId: worker.id, command: ['/app/bin/worker-v2'], args: null },
      context(adapters),
    );
    expect(edited.ok).toBe(true);
    await ship(adapters, adapter, worker.id, target.id, newer.id);

    const rolled = await rollbackDeploy(
      { componentId: worker.id, targetId: target.id, buildId: older.id },
      context(adapters),
    );
    expect(rolled.ok && first.ok).toBe(true);
    if (!rolled.ok || !first.ok) return;
    await runDeployPass(loopContext(adapter));

    const rows = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, worker.id))
      .orderBy(deploys.id);
    // The pin: the release that ran `/app/bin/worker` still says so, and no
    // later edit rewrote it.
    expect(rows.map(({ desired }) => desired.command)).toEqual([
      ['/app/bin/worker'],
      ['/app/bin/worker-v2'],
      ['/app/bin/worker-v2'],
    ]);
    // The gap: the rollback carried the older Build's config forward from
    // history but composed its entrypoint from the Component. Change
    // `rollbackDeploy` to replay the pinned document and this expectation is
    // what says so.
    expect(rows[2]?.buildId).toBe(older.id);
    expect(adapter.applied[2]?.desired.command).toEqual(['/app/bin/worker-v2']);
  });
});
