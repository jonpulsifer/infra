import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setComponentZone } from '../../src/commands/components/zone.ts';
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
    throw new Error('setComponentZone must not reach a store');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('setComponentZone must not reach the supply chain');
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

/** An App with one placed, `private`-reach Component that has a vanity name. */
async function seed(
  zone: string | null = null,
  values: {
    app?: string;
    component?: string;
    reach?: 'private' | 'public';
  } = {},
): Promise<{ appId: string; componentId: string }> {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: values.app ?? 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: values.component ?? 'web',
      kind: 'service',
      expose: true,
      reach: values.reach ?? 'private',
      vanityLabel: 'shop',
      zone,
    })
    .returning();
  // One Target holds every placement: it is unique per vessel and adapter.
  const existing = await db.select().from(targets).limit(1);
  const [target] =
    existing.length > 0
      ? existing
      : await db.insert(targets).values(targetValues()).returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
  });
  return { appId: app!.id, componentId: component!.id };
}

async function zoneOf(componentId: string): Promise<string | null | undefined> {
  const [row] = await database()
    .db.select({ zone: components.zone })
    .from(components)
    .where(eq(components.id, componentId));
  return row?.zone;
}

describe('setComponentZone', () => {
  test('refuses an unknown Component', async () => {
    const result = await setComponentZone(
      { componentId: crypto.randomUUID(), zone: null },
      context(null, 'last'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('refuses a zone that does not serve the reach, saying which', async () => {
    // `example.test` serves only public; this Component is private.
    const { componentId } = await seed();

    const result = await setComponentZone(
      { componentId, zone: 'example.test' },
      context(null, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toBe(
      "example.test serves only public; shop's web is private. " +
        'Pick a zone that serves private, or change the reach first.',
    );
    expect(result.failure.issues?.[0]?.path).toBe('zone');
    expect(await zoneOf(componentId)).toBeNull();
  });

  test('pins a zone that serves the reach and previews the names minted there', async () => {
    const { componentId } = await seed();

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(null, 'last'),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.hostnames).toEqual([
      `shop-web.${KTHX_ZONE}`,
      `shop.${KTHX_ZONE}`,
    ]);
    expect(await zoneOf(componentId)).toBe(KTHX_ZONE);
  });

  test('refuses a move onto a name another Component holds, naming the holder', async () => {
    const { componentId } = await seed();
    // Holds `shop.<kthx zone>` already, as its vanity name.
    await seed(KTHX_ZONE, { app: 'store', component: 'front' });

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(null, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toBe(
      `'${KTHX_ZONE}' would take shop.${KTHX_ZONE}, which store's front holds`,
    );
    expect(await zoneOf(componentId)).toBeNull();
  });
});

describe("setComponentZone under kthx's zone", () => {
  test('moving in reserves the canonical and vanity labels', async () => {
    const { appId, componentId } = await seed();
    const kthx = new FakeKthx();

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(await zoneOf(componentId)).toBe(KTHX_ZONE);
  });

  test('moving out makes no call and releases nothing', async () => {
    const { componentId } = await seed(KTHX_ZONE);
    const kthx = new FakeKthx();

    const result = await setComponentZone(
      { componentId, zone: 'apps.example.test' },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.calls).toEqual([]);
    expect(await zoneOf(componentId)).toBe('apps.example.test');
  });

  test("clearing the pin reserves where an unpinned Component falls through into kthx's zone", async () => {
    const { appId, componentId } = await seed('apps.example.test');
    const kthx = new FakeKthx();

    const result = await setComponentZone(
      { componentId, zone: null },
      context(kthx, 'first'),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(await zoneOf(componentId)).toBeNull();
  });

  test('a held label refuses the move on the zone input, and nothing is written', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop-web', by: 'site' }] });

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    const rule = `would take shop-web.${KTHX_ZONE}, which a kthx site holds`;
    expect(result.failure.message).toBe(`'${KTHX_ZONE}' ${rule}`);
    expect(result.failure.issues).toEqual([{ path: 'zone', message: rule }]);
    expect(await zoneOf(componentId)).toBeNull();
  });

  test('kthx not answering refuses the move and leaves the pin', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx({ unreadable: 'kthx could not be reached' });

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(kthx, 'last'),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('nothing changed');
    expect(await zoneOf(componentId)).toBeNull();
  });

  test('an installation that names no kthx makes no call', async () => {
    const { componentId } = await seed();

    const result = await setComponentZone(
      { componentId, zone: KTHX_ZONE },
      context(null, 'last'),
    );

    expect(result.ok).toBe(true);
    expect(await zoneOf(componentId)).toBe(KTHX_ZONE);
  });
});
