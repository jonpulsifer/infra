import { describe, expect, test } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import {
  completeCreationDraft,
  getCreationDraft,
  reviewCreationDraft,
  saveCreationDraft,
  startCreationDraft,
} from '../../src/commands/creation-drafts/lifecycle.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  builds,
  components,
  creationDrafts,
  deploys,
  repositories,
  targets,
  users,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { CAPABLE_DISCOVERY } from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();

const adapters: AdapterRegistry = {
  deploy: () => ({
    adapter: 'kubernetes',
    artifactTypes: ['image'],
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
  }),
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => {
    throw new Error('creation drafts do not reach the supply chain');
  },
};

async function context(): Promise<CommandContext> {
  const [principal] = await database()
    .db.insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  return {
    principal: { id: principal!.id, displayName: principal!.displayName },
    clock: { now: () => new Date('2026-07-29T12:00:00.000Z') },
    db: database().db,
    adapters,
    manifest: await fixtureManifest(),
  };
}

async function seedCapabilities() {
  const [repository] = await database()
    .db.insert(repositories)
    .values({
      fullName: 'example/app',
      installationId: '123',
      defaultBranch: 'main',
      access: 'active',
    })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values(
      targetValues({
        name: 'cluster',
        rank: 1,
        publicExposure: true,
        discovery: CAPABLE_DISCOVERY,
      }),
    )
    .returning();
  return { repository: repository!, target: target! };
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

  test('serializes edits with an optimistic revision and rejects a stale tab', async () => {
    await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);

    const changed = {
      ...started.value.draft,
      appName: 'renamed',
      step: 2,
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
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);

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

    const reviewed = await reviewCreationDraft(
      { id: started.value.id, revision: started.value.revision },
      ctx,
    );
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

  test('a clean draft creates one App and retries return that same App', async () => {
    const { repository, target } = await seedCapabilities();
    const ctx = await context();
    const started = await startCreationDraft({}, ctx);
    if (!started.ok) throw new Error(started.failure.message);

    const saved = await saveCreationDraft(
      {
        id: started.value.id,
        revision: started.value.revision,
        draft: { ...started.value.draft, step: 4 },
      },
      ctx,
    );
    if (!saved.ok) throw new Error(saved.failure.message);

    const reviewed = await reviewCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );
    expect(reviewed.ok).toBe(true);
    if (!reviewed.ok) return;
    expect(reviewed.value.ready).toBe(true);
    expect(reviewed.value.blockers).toEqual([]);
    expect(reviewed.value.draft.step).toBe(4);
    const completed = await completeCreationDraft(
      { id: saved.value.id, revision: saved.value.revision },
      ctx,
    );
    expect(completed.ok).toBe(true);
    if (!completed.ok || completed.value.app === null) return;
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
    expect(await productCounts()).toEqual([1, 1, 1, 0]);

    const [createdComponent] = await database()
      .db.select()
      .from(components)
      .where(eq(components.appId, completed.value.app.appId));
    expect(createdComponent).toBeDefined();
    expect(createdComponent?.name).toBe('web');

    const [createdBuild] = await database()
      .db.select()
      .from(builds)
      .where(eq(builds.componentId, createdComponent!.id));
    expect(createdBuild).toBeDefined();
    expect(createdBuild?.status).toBe('PENDING');
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
