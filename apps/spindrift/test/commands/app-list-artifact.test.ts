/**
 * The App list's `artifact` names the live bytes, not the config it was
 * dispatched with.
 *
 * Found on a real installation: three Apps were `LIVE`, from two different
 * source paths, and the list reported the identical value for all three. The
 * field read `deploy.configVersion` — §10's hash over a Deploy's pinned config
 * document, "total" so an empty document hashes too. None of the three Apps
 * had any config, so all three legitimately hashed the same empty document
 * and the list rendered `sha256:4f53cda18c2b…` for each — a value that reads
 * as an artifact digest without being one, and is byte-identical across every
 * App with no config regardless of what each one actually shipped.
 *
 * The scenario below reproduces that exact shape — two Apps, no config,
 * `configVersion` legitimately equal — and asserts on `artifact`, the field
 * that replaced it. A test that only checked `artifact` was some defined
 * string would still pass today; the one below fails the moment `artifact`
 * goes back to being sourced from `configVersion`, because both Apps' config
 * versions collapse to the one below by construction.
 */
import { describe, expect, test } from 'bun:test';
import { listApps } from '../../src/commands/apps/list.ts';
import { getAppWorkspace } from '../../src/commands/apps/workspace.ts';
import { createApp } from '../../src/commands/create-app.ts';
import { createComponent } from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  builds,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { configVersionOf } from '../../src/domain/config-version.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-08-04T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('the App list reached the supply chain');
  },
};

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

/**
 * One App, LIVE on its own artifact, with **no config** — the shape that made
 * every App's `configVersion` collapse to one value on the real installation.
 */
async function seedLiveApp(
  ctx: CommandContext,
  options: { readonly prefix: string; readonly artifactDigest: string },
) {
  const name = `${options.prefix}-${crypto.randomUUID().slice(0, 8)}`;
  const app = await createApp(
    {
      name,
      sourceKind: 'repo',
      repoUrl: `https://vcs.example/acme/${options.prefix}.git`,
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);

  const component = await createComponent(
    {
      appId: app.value.appId,
      name: 'web',
      kind: 'service',
      expose: true,
      reach: 'private',
      auth: 'proxy',
    },
    ctx,
  );
  if (!component.ok) throw new Error(component.failure.message);

  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes' }))
    .returning();
  await ctx.db.insert(componentTargetDesired).values({
    componentId: component.value.componentId,
    targetId: target!.id,
  });

  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: component.value.componentId,
      commit: crypto.randomUUID().slice(0, 7),
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: options.artifactDigest,
      status: 'SUCCEEDED',
      runner: 'hosted runner',
    })
    .returning();

  // §10: "total" — an empty config document hashes too, and it is the same
  // hash for every App with no config. Set explicitly, the way a real deploy
  // that pinned nothing does, rather than left `null` (which the old,
  // buggy field would have rendered as the unrelated sentinel `'latest'`).
  const emptyConfigVersion = await configVersionOf([]);

  const [deploy] = await ctx.db
    .insert(deploys)
    .values({
      componentId: component.value.componentId,
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'LIVE',
      configVersion: emptyConfigVersion,
    })
    .returning();

  return {
    appId: app.value.appId,
    name,
    configVersion: emptyConfigVersion,
    deployId: deploy!.id,
  };
}

describe('the App list names the artifact, not the config hash', () => {
  test('two Apps with distinct artifacts and identical (empty) config never share a value', async () => {
    const ctx = context();
    const a = await seedLiveApp(ctx, {
      prefix: 'sdd',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
    });
    const b = await seedLiveApp(ctx, {
      prefix: 'statty',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });

    // The precondition that made the bug invisible: both Apps really do hash
    // to the same config version, because both have no config.
    expect(a.configVersion).toBe(b.configVersion);
    expect(a.configVersion).toBe(
      'sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945',
    );

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;

    const rowA = listed.value.apps.find((app) => app.id === a.appId);
    const rowB = listed.value.apps.find((app) => app.id === b.appId);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();
    if (!rowA || !rowB) return;

    // The assertion this ticket is about: distinct artifacts, distinct rows.
    // Reverting `list.ts` to read `deploy.configVersion` makes this fail,
    // because `a.configVersion === b.configVersion` above by construction —
    // a test that only checked `artifact` was *some* string would not.
    expect(rowA.artifact).not.toBe(rowB.artifact);

    // And neither one is the config hash — the value that used to leak
    // through, rendered with a `sha256:` prefix so it read as a digest.
    expect(rowA.artifact).not.toBe(a.configVersion);
    expect(rowB.artifact).not.toBe(b.configVersion);

    // Each row actually names its own Build's digest, not the other's.
    expect(rowA.artifact).toBe(`image · sha256:${'a'.repeat(5)}`);
    expect(rowB.artifact).toBe(`image · sha256:${'b'.repeat(5)}`);
  });

  test('the list `artifact` and the workspace `release` name different things for the same Deploy', async () => {
    // The ticket's second criterion: `release` on the list and `release` on
    // the workspace carried unrelated values under one name. Resolved here by
    // giving the list's field a different name — `artifact`, the bytes that
    // are live — while the workspace keeps `release` for `Deploy <id>`, a
    // reference to the release row itself. Both answer real, different
    // questions about the same Deploy; this asserts they still do.
    const ctx = context();
    const seeded = await seedLiveApp(ctx, {
      prefix: 'sdd-private',
      artifactDigest: `sha256:${'c'.repeat(64)}`,
    });

    const listed = await listApps({}, ctx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const row = listed.value.apps.find((app) => app.id === seeded.appId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(row.artifact).toBe(`image · sha256:${'c'.repeat(5)}`);

    const workspace = await getAppWorkspace({ name: seeded.appId }, ctx);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;
    expect(workspace.value.workspace.release).toBe(`Deploy ${seeded.deployId}`);

    // Not the same value, and not meant to be — one names the release row,
    // the other names the release's bytes.
    expect(workspace.value.workspace.release).not.toBe(row.artifact);
  });
});
