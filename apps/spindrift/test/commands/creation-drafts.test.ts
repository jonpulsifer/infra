import { describe, expect, test } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import {
  completeCreationDraft,
  getCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from '../../src/commands/creation-drafts/lifecycle.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  creationDrafts,
  deploys,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import type { Draft } from '../../src/domain/creation-draft.ts';
import { draftReducer } from '../../src/domain/creation-draft.ts';
import { runBuildPass } from '../../src/reconciler/build-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import { CAPABLE_DISCOVERY } from '../harness/fakes/deploy-adapter.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const builder = new FakeBuildAdapter({ name: 'hosted' });
const stagedRepositories: string[] = [];
const supplyChain = new SupplyChainHarness();

const adapters: AdapterRegistry = {
  deploy: (adapter) => ({
    adapter,
    artifactTypes: adapter === 'static' ? ['files'] : ['image'],
    apply: async function* () {
      yield {
        type: 'status',
        at: new Date('2026-07-29T12:00:00.000Z'),
        phase: 'APPLYING',
      };
      return { phase: 'FAILED', reason: 'INTERNAL' };
    },
    observe: async () => null,
    destroy: async () => {},
    inspect: async () => {
      throw new Error('creation drafts do not inspect the far side');
    },
    tail: async () => ({ kind: 'stream', entries: [], cursor: null, reach: 0 }),
    run: async () => ({
      kind: 'none',
      because: 'creation drafts do not run anything',
    }),
    executions: async () => ({
      kind: 'none',
      because: 'creation drafts do not run anything',
    }),
  }),
  build: (name) => (name === builder.name ? builder : null),
  store: () => null,
  repository: () => null,
  source: () => ({
    async stageRepository(input) {
      stagedRepositories.push(`${input.repository}@${input.commit}`);
      return {
        digest: `sha256:${'b'.repeat(64)}`,
        location: `https://bundles.example.test/${input.commit}.tar.gz`,
        retention: 'ephemeral',
      };
    },
  }),
  supplyChain: () => supplyChain,
};

async function context(
  registry: AdapterRegistry = adapters,
): Promise<CommandContext> {
  const [principal] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return {
    principal: { id: principal!.id, displayName: principal!.displayName },
    clock: { now: () => new Date('2026-07-29T12:00:00.000Z') },
    db: database().db,
    adapters: registry,
    manifest: await fixtureManifest(),
  };
}

async function seedCapabilities(
  targetOverrides: Parameters<typeof targetValues>[0] & { name?: string } = {},
) {
  const { name = 'cluster', ...overrides } = targetOverrides;
  const [repository] = await database()
    .db.insert(repositories)
    .values({
      fullName: 'example/app',
      installationId: '123',
      defaultBranch: 'main',
      authoritativeCommit: '1111111111111111111111111111111111111111',
      access: 'active',
    })
    .returning();
  const vessel = await insertVessel(
    database().db,
    overrides.adapter ?? 'kubernetes',
    { name },
  );
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        vesselId: vessel.id,
        rank: 1,
        reaches: ['none', 'private', 'public'],
        discovery: CAPABLE_DISCOVERY,
        ...overrides,
      }),
    )
    .returning();
  return { repository: repository!, target: target! };
}

/**
 * Choose the repository, the way the screen does.
 *
 * A draft no longer opens on one — nothing preselects a repository for the
 * operator any more — so a test that wants a repository draft has to say which,
 * which is exactly the press this change added to the flow. Through
 * `draftReducer` rather than a literal, so these tests keep exercising the
 * derivation the browser runs: the App name comes off the repository, and the
 * directory goes back to the root.
 */
function pickRepository(draft: Draft, fullName = 'example/app'): Draft {
  return draftReducer(draft, {
    type: 'repo',
    fullName,
    url: `https://git.example.test/${fullName}.git`,
  });
}

/**
 * A draft that has been pointed at a repository, ready to complete.
 *
 * Two commands rather than one because that is now two acts: starting a draft
 * asks the question, and saving is the answer. Returns the saved view, so the
 * revision is the one a completion has to carry.
 */
async function startWithRepository(ctx: CommandContext) {
  const started = await startCreationDraft({}, ctx);
  if (!started.ok) throw new Error(started.failure.message);
  const saved = await saveCreationDraft(
    {
      id: started.value.id,
      revision: started.value.revision,
      draft: pickRepository(started.value.draft),
    },
    ctx,
  );
  if (!saved.ok) throw new Error(saved.failure.message);
  // The whole result, so callers read `started.value.revision` the way they do
  // off `startCreationDraft` — the extra command is the only thing that moved.
  return saved;
}

async function productCounts() {
  const tables = [apps, components, builds, deploys] as const;
  return Promise.all(
    tables.map(async (table) => {
      const [row] = await database().db.select({ value: count() }).from(table);
      return row!.value;
    }),
  );
}

describe('creation drafts', () => {
  test('replayed starts converge on one stable draft identity', async () => {
    const ctx = await context();
    await seedCapabilities();
    const id = crypto.randomUUID();

    const [left, right] = await Promise.all([
      startCreationDraft({ id }, ctx),
      startCreationDraft({ id }, ctx),
    ]);
    expect(left).toEqual(right);
    const [row] = await database()
      .db.select({ count: count() })
      .from(creationDrafts);
    expect(row?.count).toBe(1);
  });

  test('the draft it opens on names no repository, and blocks until one does', async () => {
    // It used to open on whichever active repository sorted first — so a draft
    // arrived named after a repository nobody chose, and the screen read it
    // before anybody pressed anything. Choosing is the operator's, and until
    // they have, the preflight refuses rather than building a guess.
    //
    // The clone URL that a chosen repository carries is the manifest's host
    // rather than the public one; that guarantee lives with the command that
    // now mints it — see `listRepositories` in `repositories.test.ts`.
    await seedCapabilities();
    const started = await startCreationDraft({}, await context());
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.value.draft.source).toMatchObject({
      kind: 'repo',
      repo: '',
      url: '',
    });
    expect(started.value.ready).toBe(false);
    expect(started.value.blockers.map((blocker) => blocker.code)).toContain(
      'SOURCE_UNAVAILABLE',
    );
  });

  test('refresh recovers the same server-owned draft for its operator', async () => {
    await seedCapabilities();
    const ctx = await context();

    const started = await startCreationDraft({}, ctx);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const recovered = await getCreationDraft({ id: started.value.id }, ctx);
    expect(recovered).toEqual(started);

    const [stored] = await database()
      .db.select()
      .from(creationDrafts)
      .where(eq(creationDrafts.id, started.value.id));
    expect(stored?.userId).toBe(ctx.principal.id);
    expect(stored?.revision).toBe(0);
  });

  test('a draft written before a key was retired is still editable', async () => {
    // Drafts are durable jsonb rows somebody comes back to. The save schema is
    // strict, and the browser sends back what it was given — so a retired key
    // handed out on read is a draft that refuses its own next keystroke. The
    // read drops it, which is the whole migration a jsonb column needs.
    await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    await database()
      .db.update(creationDrafts)
      .set({ draft: { ...started.value.draft, step: 4 } as never })
      .where(eq(creationDrafts.id, started.value.id));

    const recovered = await getCreationDraft({ id: started.value.id }, ctx);
    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.value.draft).not.toHaveProperty('step');

    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: recovered.value.revision,
        draft: { ...recovered.value.draft, appName: 'still-editable' },
      },
      ctx,
    );
    expect(saved.ok && saved.value.draft.appName).toBe('still-editable');
  });

  test('serializes edits with an optimistic revision and rejects a stale tab', async () => {
    await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);

    const changed = {
      ...started.value.draft,
      appName: 'renamed',
    };
    const saved = await saveCreationDraft(
      { id: started.value.id, revision: 0, draft: changed },
      ctx,
    );
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.value.revision).toBe(1);

    const stale = await saveCreationDraft(
      {
        id: started.value.id,
        revision: 0,
        draft: { ...changed, appName: 'lost-update' },
      },
      ctx,
    );
    expect(stale).toEqual({
      ok: false,
      failure: {
        code: 'STALE_EDIT',
        message:
          'this creation draft changed in another browser; reload it before saving',
      },
    });

    const recovered = await getCreationDraft({ id: started.value.id }, ctx);
    expect(recovered.ok && recovered.value.draft.appName).toBe('renamed');
  });

  test('revalidates stale repository and Target choices without creating product rows', async () => {
    const { repository, target } = await seedCapabilities();
    const ctx = await context();
    const started = await startWithRepository(ctx);

    await database()
      .db.update(repositories)
      .set({
        access: 'frozen',
        frozenReason: 'installation access was revoked',
        frozenAt: new Date(),
      })
      .where(eq(repositories.id, repository.id));
    await database()
      .db.update(targets)
      .set({ health: 'unhealthy' })
      .where(eq(targets.id, target.id));

    const reviewed = await getCreationDraft({ id: started.value.id }, ctx);
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.ready).toBe(false);
    expect(reviewed.value.blockers.map((blocker) => blocker.code)).toEqual(
      expect.arrayContaining(['REPOSITORY_UNAVAILABLE', 'TARGET_UNAVAILABLE']),
    );
    const completed = await completeCreationDraft(
      { id: started.value.id, revision: started.value.revision },
      ctx,
    );
    expect(completed.ok && completed.value.app).toBeNull();
    expect(await productCounts()).toEqual([0, 0, 0, 0]);

    const recovered = await getCreationDraft({ id: started.value.id }, ctx);
    expect(recovered.ok).toBe(true);
  });

  test('a clean repository draft creates and dispatches one complete first-Build intent', async () => {
    const { repository, target } = await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);

    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: pickRepository(started.value.draft),
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const reviewed = await getCreationDraft({ id: saved.value.id }, ctx);
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.ready).toBe(true);
    expect(reviewed.value.blockers).toEqual([]);
    expect(reviewed.value.draft.componentName).toBe('web');
    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok || completed.value.app === null) return;
    expect(completed.value.app).toMatchObject({
      componentName: 'web',
      targetId: target.id,
      buildStatus: 'PENDING',
    });
    expect(completed.value.app.buildId).toBeGreaterThan(0);
    expect(stagedRepositories).toEqual([
      'example/app@1111111111111111111111111111111111111111',
    ]);
    expect(builder.built).toHaveLength(0);
    expect(await productCounts()).toEqual([1, 1, 1, 0]);
    expect(
      await database().db.select().from(componentTargetDesired),
    ).toHaveLength(1);
    await database()
      .db.update(repositories)
      .set({
        access: 'frozen',
        frozenReason: 'access changed after completion',
      })
      .where(eq(repositories.id, repository.id));
    await database()
      .db.update(targets)
      .set({ health: 'unhealthy' })
      .where(eq(targets.id, target.id));
    const retried = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );
    expect(retried).toEqual(completed);
    expect(await runBuildPass(ctx)).toBe(1);
    expect(builder.built).toHaveLength(1);
    expect(builder.built[0]?.source).toMatchObject({
      bundleDigest: `sha256:${'b'.repeat(64)}`,
      origin: {
        type: 'repo',
        repository: 'example/app',
        commit: '1111111111111111111111111111111111111111',
        subpath: '.',
        location:
          'https://bundles.example.test/1111111111111111111111111111111111111111.tar.gz',
      },
    });
    const [finished] = await database().db.select().from(builds);
    expect(finished?.status).toBe('SUCCEEDED');
    expect(await productCounts()).toEqual([1, 1, 1, 0]);
  });

  test('completion is reachable through the validated command boundary', async () => {
    await seedCapabilities();
    const ctx = await context();
    const started = await startWithRepository(ctx);

    const completed = await dispatch(
      'completeCreationDraft',
      { id: started.value.id, revision: started.value.revision },
      ctx,
    );

    expect(completed).toMatchObject({
      ok: true,
      value: {
        app: {
          name: started.value.draft.appName,
          buildStatus: 'PENDING',
        },
      },
    });
    expect(await productCounts()).toEqual([1, 1, 1, 0]);
  });

  test('concurrent Review retries hand one durable Build to the runner once', async () => {
    await seedCapabilities();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let calls = 0;
    let stageCalls = 0;
    const base = new FakeBuildAdapter({ name: 'hosted' });
    const delayed = {
      name: base.name,
      logFidelity: base.logFidelity,
      buildLevel: base.buildLevel,
      provenanceBuilderId: base.provenanceBuilderId,
      carriesHeldSecret: base.carriesHeldSecret,
      // Every flavour, matching `FakeBuildAdapter`'s default: these fakes stand in
      // for a route, not for one route's reach.
      selfAuthorizedRegistries: [
        'artifactRegistry',
        'dockerHub',
        'ghcr',
        'other',
      ] as const,
      cancel: async () => {},
      async *build(
        source: Parameters<typeof base.build>[0],
        spec: Parameters<typeof base.build>[1],
      ) {
        calls += 1;
        markEntered();
        await gate;
        return yield* base.build(source, spec);
      },
    };
    const registry: AdapterRegistry = {
      ...adapters,
      build: (name) => (name === delayed.name ? delayed : null),
      source: () => ({
        async stageRepository(input) {
          stageCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            digest: `sha256:${'b'.repeat(64)}`,
            location: `https://bundles.example.test/${input.commit}.tar.gz`,
            retention: 'ephemeral',
          };
        },
      }),
    };
    const ctx = await context(registry);
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: pickRepository(started.value.draft),
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const input = { id: saved.value.id, revision: saved.value.revision };
    const [first, second] = await Promise.all([
      completeCreationDraft(input, ctx),
      completeCreationDraft(input, ctx),
    ]);
    expect(stageCalls).toBe(1);
    expect(calls).toBe(0);

    const left = runBuildPass(ctx);
    const right = runBuildPass(ctx);
    await entered;
    expect(calls).toBe(1);
    release();
    await Promise.all([left, right]);

    expect(first.ok && first.value.app?.appId).toBe(
      second.ok && second.value.app?.appId,
    );
    expect(first.ok && first.value.app?.buildId).toBe(
      second.ok && second.value.app?.buildId,
    );
    expect(calls).toBe(1);
    expect(await productCounts()).toEqual([1, 1, 1, 0]);
  });

  test('a staged source archive follows the same builder path', async () => {
    await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    const beforeBuilds = builder.built.length;
    const digest = `sha256:${'c'.repeat(64)}`;
    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: {
          ...pickRepository(started.value.draft),
          entry: 'upload',
          source: {
            kind: 'archive',
            filename: 'source.zip',
            digest,
            location: 'https://bundles.example.test/source.zip',
            contents: 'source',
            subpath: 'service',
          },
        },
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );

    expect(completed.ok && completed.value.app?.buildStatus).toBe('PENDING');
    expect(await runBuildPass(ctx)).toBe(1);
    expect(builder.built).toHaveLength(beforeBuilds + 1);
    expect(builder.built.at(-1)?.source).toEqual({
      bundleDigest: digest,
      origin: {
        type: 'archive',
        location: 'https://bundles.example.test/source.zip',
        subpath: 'service',
      },
    });
  });

  test('a supplied finished archive creates a files Build without invoking a builder', async () => {
    const { target } = await seedCapabilities({
      adapter: 'static',
      name: 'cdn',
    });
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    const beforeBuilds = builder.built.length;
    const digest = `sha256:${'d'.repeat(64)}`;
    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: {
          ...pickRepository(started.value.draft),
          entry: 'upload',
          source: {
            kind: 'archive',
            filename: 'dist.zip',
            digest,
            location: 'https://bundles.example.test/dist.zip',
            contents: 'artifact',
            subpath: '.',
          },
          detection: {
            ...pickRepository(started.value.draft).detection,
            kind: 'website',
          },
          kind: 'website',
          reach: 'public',
          auth: 'none',
          targetId: target.id,
        },
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );

    expect(completed.ok && completed.value.app?.buildStatus).toBe('SUCCEEDED');
    expect(builder.built).toHaveLength(beforeBuilds);
    const [build] = await database().db.select().from(builds);
    expect(build).toMatchObject({
      artifactType: 'files',
      artifactDigest: digest,
      artifactRefs: ['https://bundles.example.test/dist.zip'],
      runner: null,
    });
  });

  test('a supplied finished archive requires a files-capable target', async () => {
    const { target } = await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: {
          ...pickRepository(started.value.draft),
          entry: 'upload',
          source: {
            kind: 'archive',
            filename: 'dist.zip',
            digest: `sha256:${'f'.repeat(64)}`,
            location: 'https://bundles.example.test/dist.zip',
            contents: 'artifact',
            subpath: '.',
          },
          detection: {
            ...pickRepository(started.value.draft).detection,
            kind: 'website',
          },
          kind: 'website',
          reach: 'public',
          auth: 'none',
          targetId: target.id,
        },
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );

    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect(completed.value.app).toBeNull();
    expect(completed.value.draft.blockers).toContainEqual(
      expect.objectContaining({ code: 'TARGET_UNAVAILABLE' }),
    );
    expect(await productCounts()).toEqual([0, 0, 0, 0]);
  });

  test('an unstaged archive leaves the resumable draft and no product intent', async () => {
    await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);
    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: {
          ...pickRepository(started.value.draft),
          source: {
            kind: 'archive',
            filename: 'missing.zip',
            digest: `sha256:${'e'.repeat(64)}`,
            location: null,
            contents: 'source',
            subpath: '.',
          },
        },
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );

    expect(completed).toMatchObject({
      ok: true,
      value: {
        app: null,
        draft: {
          ready: false,
          blockers: [{ code: 'SOURCE_UNAVAILABLE' }],
        },
      },
    });
    expect(await productCounts()).toEqual([0, 0, 0, 0]);
    expect(await getCreationDraft({ id: saved.value.id }, ctx)).toMatchObject({
      ok: true,
    });
  });

  test('repository staging failure is a refusal before durable intent', async () => {
    await seedCapabilities();
    const registry: AdapterRegistry = {
      ...adapters,
      source: () => ({
        async stageRepository() {
          throw new Error('bundle depot is unavailable');
        },
      }),
    };
    const ctx = await context(registry);
    const started = await startWithRepository(ctx);

    const completed = await completeCreationDraft(
      { id: started.value.id, revision: started.value.revision },
      ctx,
    );

    expect(completed).toMatchObject({
      ok: false,
      failure: {
        code: 'NOT_BUILDABLE',
        message: expect.stringContaining('bundle depot is unavailable'),
      },
    });
    expect(await productCounts()).toEqual([0, 0, 0, 0]);
    expect(await getCreationDraft({ id: started.value.id }, ctx)).toMatchObject(
      { ok: true },
    );
  });

  test('a runner crash after durable intent is visible as a failed Build', async () => {
    await seedCapabilities();
    const crashing = {
      name: 'hosted',
      logFidelity: 'LIVE_TEXT' as const,
      buildLevel: 2 as const,
      provenanceBuilderId: 'https://builders.example.test/crashing',
      carriesHeldSecret: true,
      // Every flavour, matching `FakeBuildAdapter`'s default: these fakes stand in
      // for a route, not for one route's reach.
      selfAuthorizedRegistries: [
        'artifactRegistry',
        'dockerHub',
        'ghcr',
        'other',
      ] as const,
      cancel: async () => {},
      async *build(): AsyncGenerator<never, never, void> {
        yield* [];
        throw new Error('runner connection vanished');
      },
    };
    const registry: AdapterRegistry = {
      ...adapters,
      build: (name) => (name === crashing.name ? crashing : null),
    };
    const ctx = await context(registry);
    const started = await startWithRepository(ctx);

    const completed = await completeCreationDraft(
      { id: started.value.id, revision: started.value.revision },
      ctx,
    );

    expect(completed).toMatchObject({
      ok: true,
      value: {
        app: {
          buildStatus: 'PENDING',
        },
      },
    });
    expect(await runBuildPass(ctx)).toBe(1);
    expect(await productCounts()).toEqual([1, 1, 1, 0]);
    const [build] = await database().db.select().from(builds);
    expect(build?.status).toBe('FAILED');
  });

  test('another operator cannot read or edit the draft', async () => {
    await seedCapabilities();
    const owner = await context();
    const other = await context();
    const started = await startCreationDraft({}, owner);
    if (!started.ok) throw new Error(started.failure.message);

    const read = await getCreationDraft({ id: started.value.id }, other);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.failure.code).toBe('NOT_FOUND');
  });
});
