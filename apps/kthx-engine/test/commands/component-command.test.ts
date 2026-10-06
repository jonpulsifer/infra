// Components off one image differ only by entrypoint. The Deploy pins it, and a
// rollback restores it with the artifact.
import { describe, expect, test } from 'bun:test';
import { desc, eq } from 'drizzle-orm';
import { workloadContainer } from '../../src/adapters/deploy/cloudrun/service.ts';
import { appValues } from '../../src/adapters/deploy/kubernetes/values.ts';
import {
  setComponentCommand,
  setComponentCommandInput,
} from '../../src/commands/components/command.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
import { rollbackDeploy } from '../../src/commands/deploys/rollback.ts';
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

/** The one image every Build here produces, as in a monolith. */
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
    expect(
      adapter.applied.map(({ desired }) => desired.artifact.digest),
    ).toEqual([DIGEST, DIGEST]);
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
    // Absent from the document when the row is null.
    expect(desired.command).toBeUndefined();
    expect(desired.args).toBeUndefined();
    // `[]` in the values: the chart's `with` skips an empty list as it skips an
    // absent key.
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

    // Rendered from the same documents, so neither adapter drops the
    // entrypoint.
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

    // Absent here, unlike the chart: Cloud Run reads an empty `command` as an
    // override that runs nothing.
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
    // The row changed, and nothing is applied until a Deploy is pressed.
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

    // The pin tells a repeat from a change.
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
    // desiredStateFor spreads deploy.desired, so the pinned row is what is
    // applied.
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

    expect(adapter.applied[1]?.desired.command).toBeUndefined();
    expect(adapter.applied[1]?.desired.args).toBeUndefined();
    expect(
      appValues(adapter.applied[1]!.desired, 'x@sha256:1', 'app-shop').command,
    ).toEqual([]);
  });
});

describe('a rollback and the entrypoint the older release ran with', () => {
  // An entrypoint says how the artifact runs, so a rollback replays it. Reach,
  // auth and expose say where it answers, so they do not.
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
    // The older release still names its entrypoint, and the rollback's new
    // intent carries it forward.
    expect(rows.map(({ desired }) => desired.command)).toEqual([
      ['/app/bin/worker'],
      ['/app/bin/worker-v2'],
      ['/app/bin/worker'],
    ]);
    expect(rows[2]?.buildId).toBe(older.id);
    expect(adapter.applied[2]?.desired.command).toEqual(['/app/bin/worker']);
  });

  // A schedule says how the artifact runs, so it replays with the entrypoint.
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
    // Edited between the releases, so today's Component disagrees with the pin.
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

  // A rollback that replayed the pinned reach would republish what an operator
  // withdrew.
  test('a rollback does not put back a reach somebody withdrew', async () => {
    const { app, target } = await fixture();
    // The fixture's Target asserts no `reaches`, and a public Component needs
    // one.
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
    // Withdrawn from the public internet between the releases.
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

    // The older release was public; the rollback's own intent is not.
    expect(placed?.buildId).toBe(older.id);
    expect(placed?.desired.reach).toBe('none');
  });
});
