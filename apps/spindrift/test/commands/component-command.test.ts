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
 * - **The pin survives a later edit, and a rollback reads it.** Both halves
 *   asserted. 119 claimed the second and core did not do it; 122 decided it
 *   and this is the shape it settled on — a rollback restores how the artifact
 *   ran, so the entrypoint comes back with it, while reach and auth do not.
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
      appValues(desired, `ghcr.io/example/monolith@${DIGEST}`, 'app-shop'),
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
    const values = appValues(
      desired,
      `ghcr.io/example/monolith@${DIGEST}`,
      'app-shop',
    );
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
      appValues(adapter.applied[1]!.desired, 'x@sha256:1', 'app-shop').command,
    ).toEqual([]);
  });
});

describe('a rollback and the entrypoint the older release ran with', () => {
  /**
   * **The pin, and the rollback that now reads it.**
   *
   * 119 claimed a rollback "restores the entrypoint that release ran with" and
   * core did not do it: `rollbackDeploy` overrode exactly one field from
   * history, `config`. This test recorded that gap rather than papering over
   * it, and said a future change should make it go red here. 122 is that
   * change.
   *
   * An entrypoint is how the artifact **runs**, so it replays — bringing a
   * binary back under an entrypoint it was never released with runs a different
   * process wearing the old digest. `reach`, `auth` and `expose` do not replay,
   * because they say where it **answers**, and a rollback during an incident
   * must not republish something an operator made private.
   *
   * Both halves are still asserted: the older row still names what it shipped
   * (nothing rewrote history), and the new intent the rollback wrote carries
   * that entrypoint forward.
   */
  test('the older release keeps its entrypoint, and the rollback runs it', async () => {
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
    // later edit rewrote it. The third row is the rollback's own new intent,
    // which carries that entrypoint rather than the Component's current one.
    expect(rows.map(({ desired }) => desired.command)).toEqual([
      ['/app/bin/worker'],
      ['/app/bin/worker-v2'],
      ['/app/bin/worker'],
    ]);
    // And it is what actually reached the adapter: the older Build, running
    // the way it ran.
    expect(rows[2]?.buildId).toBe(older.id);
    expect(adapter.applied[2]?.desired.command).toEqual(['/app/bin/worker']);
  });

  /**
   * The entrypoint is not alone on its side of 122's line.
   *
   * A schedule says how the artifact runs — a nightly job brought back on
   * whatever cadence the Component carries today is running on a clock it was
   * never released with. It replays for the same reason `command` does, and
   * this asserts they moved together rather than one field at a time, which is
   * what 122 refused to accept.
   *
   * The other side of the line — that `reach` does *not* come back — is
   * asserted in `component-reach.test.ts`, where the Target is set up to serve
   * a public reach in the first place.
   */
  test('a rollback restores the cadence the release ran on', async () => {
    const { app, target } = await fixture();
    const nightly = await component(app.id, 'nightly');
    await database()
      .db.update(components)
      .set({ kind: 'job', schedule: '0 3 * * *' })
      .where(eq(components.id, nightly.id));

    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    const older = await build(nightly.id, 'abcdef0');
    const newer = await build(nightly.id, 'bcdef01');

    await ship(adapters, adapter, nightly.id, target.id, older.id);
    // Edited between the two releases, so today's Component disagrees with the
    // pinned document.
    await database()
      .db.update(components)
      .set({ schedule: '0 5 * * *' })
      .where(eq(components.id, nightly.id));
    await ship(adapters, adapter, nightly.id, target.id, newer.id);

    const rolled = await rollbackDeploy(
      { componentId: nightly.id, targetId: target.id, buildId: older.id },
      context(adapters),
    );
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    const [placed] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, nightly.id))
      .orderBy(desc(deploys.id))
      .limit(1);

    expect(placed?.desired.schedule).toBe('0 3 * * *');
  });

  /**
   * The other side of 122's line, and the one that protects an operator.
   *
   * `reach` says where the artifact answers, not how it runs, so a rollback
   * leaves it as the Component has it today. The scenario is the one that makes
   * the rule worth having: something was published, it went wrong, somebody
   * pulled it off the public internet, and *then* the bad release is rolled
   * back. Replaying the pinned reach would republish it — during an incident,
   * as a side effect of an unrelated act.
   */
  test('a rollback does not put back a reach somebody withdrew', async () => {
    const { app, target } = await fixture();
    // The Target has to be able to serve a public reach for one to be placed;
    // `fixture` leaves discovery unset, which makes every Component private.
    await database()
      .db.update(targets)
      .set({ reaches: ['none', 'private', 'public'] })
      .where(eq(targets.id, target.id));
    const web = await component(app.id, 'web');
    await database()
      .db.update(components)
      .set({ reach: 'public' })
      .where(eq(components.id, web.id));

    const adapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapters = registryOf(adapter);
    const older = await build(web.id, 'abcdef0');
    const newer = await build(web.id, 'bcdef01');

    await ship(adapters, adapter, web.id, target.id, older.id);
    // Taken down off the public internet, deliberately, between the releases.
    await database()
      .db.update(components)
      .set({ reach: 'none' })
      .where(eq(components.id, web.id));
    await ship(adapters, adapter, web.id, target.id, newer.id);

    const rolled = await rollbackDeploy(
      { componentId: web.id, targetId: target.id, buildId: older.id },
      context(adapters),
    );
    expect(rolled.ok).toBe(true);
    if (!rolled.ok) return;

    const [placed] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, web.id))
      .orderBy(desc(deploys.id))
      .limit(1);

    // The older release was public and the row still says so; the rollback's
    // own intent is not.
    expect(placed?.buildId).toBe(older.id);
    expect(placed?.desired.reach).toBe('none');
  });
});
