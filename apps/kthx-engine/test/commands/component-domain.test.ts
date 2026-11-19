import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setComponentDomain } from '../../src/commands/components/domain.ts';
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
const manifest = withKthxZone(await fixtureManifest(), 'last');

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('setComponentDomain must not reach a store');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('setComponentDomain must not reach the supply chain');
  },
};

function context(kthx: FakeKthx | null = null): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => new Date('2026-11-19T00:00:00.000Z') },
    db: database().db,
    adapters: kthx === null ? noAdapters : { ...noAdapters, kthx: () => kthx },
    manifest,
  };
}

/** A placed, `private`-reach service, unpinned, named `shop` unless told. */
async function seed(
  values: {
    app?: string;
    component?: string;
    zone?: string | null;
    vanityLabel?: string | null;
  } = {},
): Promise<string> {
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
      reach: 'private',
      zone: values.zone ?? null,
      vanityLabel:
        values.vanityLabel === undefined ? 'shop' : values.vanityLabel,
    })
    .returning();
  const existing = await db.select().from(targets).limit(1);
  const [target] =
    existing.length > 0
      ? existing
      : await db.insert(targets).values(targetValues()).returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
  });
  return component!.id;
}

async function namesOf(componentId: string) {
  const [row] = await database()
    .db.select({ zone: components.zone, label: components.vanityLabel })
    .from(components)
    .where(eq(components.id, componentId));
  return row;
}

describe('setComponentDomain', () => {
  test('writes the zone and the label together and previews both', async () => {
    const componentId = await seed();

    const result = await setComponentDomain(
      { componentId, zone: KTHX_ZONE, label: 'store' },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.hostnames).toEqual([
      `shop-web.${KTHX_ZONE}`,
      `store.${KTHX_ZONE}`,
    ]);
    expect(await namesOf(componentId)).toEqual({
      zone: KTHX_ZONE,
      label: 'store',
    });
  });

  test('checks the pair it writes, not the old label in the new zone', async () => {
    const componentId = await seed();
    await seed({ app: 'other', component: 'front', zone: KTHX_ZONE });

    const result = await setComponentDomain(
      { componentId, zone: KTHX_ZONE, label: 'store' },
      context(),
    );

    expect(result.ok).toBe(true);
  });

  test('a refused label leaves the zone as it was', async () => {
    const componentId = await seed();

    const result = await setComponentDomain(
      { componentId, zone: KTHX_ZONE, label: 'Not A Label' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.issues?.[0]?.path).toBe('label');
    expect(await namesOf(componentId)).toEqual({ zone: null, label: 'shop' });
  });

  test('an empty label is refused rather than read as none', async () => {
    const componentId = await seed();

    const result = await setComponentDomain(
      { componentId, zone: null, label: '' },
      context(),
    );

    expect(result.ok).toBe(false);
    expect(await namesOf(componentId)).toEqual({ zone: null, label: 'shop' });
  });

  test('a name another Component holds is refused on the input that mints it', async () => {
    const componentId = await seed({ vanityLabel: null });
    await seed({ app: 'other', component: 'front', zone: KTHX_ZONE });

    const result = await setComponentDomain(
      { componentId, zone: KTHX_ZONE, label: 'shop' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toBe(
      `would take shop.${KTHX_ZONE}, which other's front holds`,
    );
    expect(result.failure.issues?.[0]?.path).toBe('label');
    expect(await namesOf(componentId)).toEqual({ zone: null, label: null });
  });

  test('a zone that does not serve the reach is refused, and nothing is written', async () => {
    const componentId = await seed();

    const result = await setComponentDomain(
      { componentId, zone: 'example.test', label: 'store' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.issues?.[0]?.path).toBe('zone');
    expect(await namesOf(componentId)).toEqual({ zone: null, label: 'shop' });
  });

  test('a label kthx holds is refused, and nothing is written', async () => {
    const componentId = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'store', by: 'site' }] });

    const result = await setComponentDomain(
      { componentId, zone: KTHX_ZONE, label: 'store' },
      context(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toBe(
      `'store' would take store.${KTHX_ZONE}, which a kthx site holds`,
    );
    expect(await namesOf(componentId)).toEqual({ zone: null, label: 'shop' });
  });
});
