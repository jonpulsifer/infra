import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppZone } from '../../src/commands/apps/zone.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  components,
  componentTargetDesired,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeKthx, KTHX_ZONE, withKthxZone } from '../harness/fakes/kthx.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('setAppZone must not reach a store');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('setAppZone must not reach the supply chain');
  },
};

function context(
  kthx: FakeKthx | null,
  where: 'first' | 'last',
): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => new Date('2026-10-01T00:00:00.000Z') },
    db: database().db,
    adapters: kthx === null ? noAdapters : { ...noAdapters, kthx: () => kthx },
    manifest: withKthxZone(manifest, where),
  };
}

/** An App with a vanity name and one placed, `private`-reach Component. */
async function seed(zone: string | null = null): Promise<string> {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive', vanityDomain: 'shop', zone })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
    .returning();
  const [target] = await db.insert(targets).values(targetValues()).returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
  });
  return app!.id;
}

async function zoneOf(appId: string): Promise<string | null | undefined> {
  const [row] = await database()
    .db.select({ zone: apps.zone })
    .from(apps)
    .where(eq(apps.id, appId));
  return row?.zone;
}

describe("setAppZone under kthx's zone", () => {
  test('moving in reserves the canonical and vanity labels', async () => {
    const appId = await seed();
    const kthx = new FakeKthx();

    const result = await setAppZone(
      { appId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(await zoneOf(appId)).toBe(KTHX_ZONE);
  });

  test('moving out makes no call and releases nothing', async () => {
    const appId = await seed(KTHX_ZONE);
    const kthx = new FakeKthx();

    const result = await setAppZone(
      { appId, zone: 'apps.example.test' },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.calls).toEqual([]);
    expect(await zoneOf(appId)).toBe('apps.example.test');
  });

  test("clearing the pin reserves where an unpinned App falls through into kthx's zone", async () => {
    const appId = await seed('apps.example.test');
    const kthx = new FakeKthx();

    const result = await setAppZone(
      { appId, zone: null },
      context(kthx, 'first'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(await zoneOf(appId)).toBeNull();
  });

  test('a held label refuses the move on the zone input, and nothing is written', async () => {
    const appId = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop-web', by: 'site' }] });

    const result = await setAppZone(
      { appId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    const rule = `would take shop-web.${KTHX_ZONE}, which a kthx site holds`;
    expect(result.failure.message).toBe(`'${KTHX_ZONE}' ${rule}`);
    expect(result.failure.issues).toEqual([{ path: 'zone', message: rule }]);
    expect(await zoneOf(appId)).toBeNull();
  });

  test('kthx not answering refuses the move and leaves the pin', async () => {
    const appId = await seed();
    const kthx = new FakeKthx({ unreadable: 'kthx could not be reached' });

    const result = await setAppZone(
      { appId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('nothing changed');
    expect(await zoneOf(appId)).toBeNull();
  });

  test('an installation that names no kthx makes no call', async () => {
    const appId = await seed();

    const result = await setAppZone(
      { appId, zone: KTHX_ZONE },
      context(null, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(await zoneOf(appId)).toBe(KTHX_ZONE);
  });
});
