/**
 * An App opting in to deploying on push (§15).
 *
 * `apps.autoDeploy` shipped with its reader (`reconciler/auto-deploy.ts`) and
 * its trigger (the webhook route) and with **no writer at all** — the column
 * defaults `false`, `createApp` does not take it, and no command set it. So
 * deploy-on-push was complete, merged, and permanently off. Three claims:
 *
 * - **The switch actually moves the column**, which is the whole gap.
 * - **An archive App is refused**, because `dispatchAutoDeploys` reads the
 *   scopes of repository reconciliation passes — an App with no repository is
 *   not something it can ever reach, so `true` there would be a switch that
 *   sits on and never fires.
 * - **The dispatcher deploys what this turned on, and only that.** The reader
 *   and the writer meet here or they do not meet anywhere: a test that only
 *   asserted the column would pass just as well against a column nothing reads.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppAutoDeploy } from '../../src/commands/apps/auto-deploy.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps, repositories, users } from '../../src/db/schema.ts';
import { dispatchAutoDeploys } from '../../src/reconciler/auto-deploy.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-06T12:00:00.000Z');

const adapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  supplyChain: () => null,
  repository: () => null,
} as unknown as AdapterRegistry;

describe('deploy on push, turned on and off', () => {
  let ctx: CommandContext;
  let repoAppId: string;
  let archiveAppId: string;

  beforeEach(async () => {
    const { client, db } = database();
    await db.delete(apps);
    await db.delete(repositories);
    await db.delete(users);

    const [operator] = await db
      .insert(users)
      .values({ displayName: 'Operator' })
      .returning();
    const [repository] = await db
      .insert(repositories)
      .values({
        fullName: 'jonpulsifer/infra',
        installationId: '1',
        defaultBranch: 'main',
      })
      .returning();
    const [repoApp] = await db
      .insert(apps)
      .values({
        name: 'statty',
        sourceKind: 'repo',
        sourceRepoUrl: 'jonpulsifer/infra',
        sourceRepoSubpath: 'apps/statty',
        repositoryId: repository!.id,
      })
      .returning();
    repoAppId = repoApp!.id;
    const [archiveApp] = await db
      .insert(apps)
      .values({ name: 'archivetest', sourceKind: 'archive' })
      .returning();
    archiveAppId = archiveApp!.id;

    ctx = {
      client,
      db,
      adapters,
      clock: { now: () => FROZEN },
      manifest,
      operatorId: operator!.id,
      principal: { type: 'user', id: operator!.id, displayName: 'Operator' },
    } as CommandContext;
  });

  async function autoDeployOf(id: string): Promise<boolean | undefined> {
    const [row] = await database()
      .db.select({ autoDeploy: apps.autoDeploy })
      .from(apps)
      .where(eq(apps.id, id));
    return row?.autoDeploy;
  }

  test('the column every App defaults to, and the one nothing could change', async () => {
    // The state this ticket is about: shipped, readable, and unreachable.
    expect(await autoDeployOf(repoAppId)).toBe(false);
  });

  test('turning it on writes the column and names what it fires on', async () => {
    const result = await setAppAutoDeploy(
      { appId: repoAppId, autoDeploy: true },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.autoDeploy).toBe(true);
      // "On" is never reported without saying what it is on *for*.
      expect(result.value.repository).toBe('jonpulsifer/infra');
    }
    expect(await autoDeployOf(repoAppId)).toBe(true);
  });

  test('turning it off writes the column back', async () => {
    await setAppAutoDeploy({ appId: repoAppId, autoDeploy: true }, ctx);
    const result = await setAppAutoDeploy(
      { appId: repoAppId, autoDeploy: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(await autoDeployOf(repoAppId)).toBe(false);
  });

  test('an archive App is refused, because no push can reach it', async () => {
    const result = await setAppAutoDeploy(
      { appId: archiveAppId, autoDeploy: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain('uploaded archive');
    }
    // And it is refused *before* the write, not reported after one.
    expect(await autoDeployOf(archiveAppId)).toBe(false);
  });

  test('an App that does not exist is not silently a no-op', async () => {
    const result = await setAppAutoDeploy(
      { appId: '00000000-0000-4000-8000-000000000000', autoDeploy: true },
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('the dispatcher deploys the App this turned on, and skips the one it did not', async () => {
    // The claim that makes the other five worth anything: the writer and the
    // reader are the same column. `dispatchAutoDeploys` selects on
    // `apps.autoDeploy = true`, so an App this command has not switched on is
    // not attempted at all — no `deployApp` call, no adapter needed.
    const { db } = database();
    const [second] = await db
      .insert(apps)
      .values({
        name: 'plainboi',
        sourceKind: 'repo',
        sourceRepoUrl: 'jonpulsifer/infra',
        sourceRepoSubpath: 'apps/plainboi',
      })
      .returning();

    await setAppAutoDeploy({ appId: repoAppId, autoDeploy: true }, ctx);

    const attempts = await dispatchAutoDeploys(
      { db, clock: ctx.clock, adapters, manifest },
      [
        {
          outcome: 'adopted',
          scopes: [{ appId: repoAppId }, { appId: second!.id }],
        },
      ] as never,
    );

    expect(attempts.map((attempt) => attempt.appId)).toEqual([repoAppId]);
  });

  test('nothing is dispatched from a pass that adopted no commit', async () => {
    // `unchanged`, `frozen`, `rejected`, `unavailable` all mean nothing landed.
    // An opted-in App must not redeploy on a pass that found no new commit.
    await setAppAutoDeploy({ appId: repoAppId, autoDeploy: true }, ctx);

    const attempts = await dispatchAutoDeploys(
      { db: database().db, clock: ctx.clock, adapters, manifest },
      [{ outcome: 'unchanged', scopes: [{ appId: repoAppId }] }] as never,
    );

    expect(attempts).toEqual([]);
  });
});
