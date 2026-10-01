import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { setAppVanity } from '../../src/commands/apps/vanity.ts';
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
    throw new Error('setAppVanity must not reach an adapter');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('setAppVanity must not reach an adapter');
  },
};

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => new Date('2026-08-22T00:00:00.000Z') },
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

const kthxManifest = withKthxZone(manifest, 'first');

function kthxContext(
  kthx: FakeKthx,
  installation: CommandContext['manifest'] = kthxManifest,
): CommandContext {
  return {
    ...context(),
    adapters: { ...noAdapters, kthx: () => kthx },
    manifest: installation,
  };
}

async function vanityOf(appId: string): Promise<string | null | undefined> {
  const [row] = await database()
    .db.select({ vanityDomain: apps.vanityDomain })
    .from(apps)
    .where(eq(apps.id, appId));
  return row?.vanityDomain;
}

/** An App with one placed, `private`-reach Component on a cluster Target. */
async function seed(): Promise<{ appId: string }> {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
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
  return { appId: app!.id };
}

describe('setAppVanity', () => {
  test('refuses an unknown App', async () => {
    const result = await setAppVanity(
      { appId: crypto.randomUUID(), label: 'shop' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('refuses a label that is not one DNS label or the apex, and writes nothing', async () => {
    const { appId } = await seed();
    const result = await setAppVanity(
      { appId, label: 'shop.example.test' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toContain('@');

    const [row] = await database()
      .db.select({ vanityDomain: apps.vanityDomain })
      .from(apps)
      .where(eq(apps.id, appId));
    expect(row?.vanityDomain).toBeNull();
  });

  test("refuses a label that would take the installation's own or reserved names, in any zone", async () => {
    const { appId } = await seed();
    // None clashes in this App's zone today; a later zone or a public reach
    // would.
    for (const [label, taken] of [
      ['spindrift', manifest.controlPlane.hostname],
      ['spindrift-control', manifest.controlPlane.publicHostname],
      ['kthx', manifest.controlPlane.reservedHostnames[0]],
    ] as const) {
      const result = await setAppVanity({ appId, label }, context());
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain(taken!);
      expect(result.failure.issues).toEqual([
        { path: 'label', message: expect.stringContaining(taken!) },
      ]);
    }

    const [row] = await database()
      .db.select({ vanityDomain: apps.vanityDomain })
      .from(apps)
      .where(eq(apps.id, appId));
    expect(row?.vanityDomain).toBeNull();
  });

  test('refuses the apex of a zone that is one of those names', async () => {
    const { appId } = await seed();
    const own = manifest.controlPlane.hostname;
    const result = await setAppVanity(
      { appId, label: '@' },
      {
        ...context(),
        manifest: {
          ...manifest,
          dns: {
            zones: [
              ...manifest.dns.zones,
              { name: own, reaches: ['private', 'public'] },
            ],
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toContain(own);
  });

  test('a label that only starts with one of them is its own name', async () => {
    const { appId } = await seed();
    const result = await setAppVanity(
      { appId, label: 'spindrift-shop' },
      context(),
    );
    expect(result.ok).toBe(true);
  });

  test('writes the label and previews the canonical and vanity names side by side', async () => {
    const { appId } = await seed();
    const result = await setAppVanity({ appId, label: 'shop' }, context());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.vanity).toBe('shop');
    // The canonical name is still minted beside the vanity.
    expect(result.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'shop.apps.example.test',
    ]);

    const [row] = await database()
      .db.select({ vanityDomain: apps.vanityDomain })
      .from(apps)
      .where(eq(apps.id, appId));
    expect(row?.vanityDomain).toBe('shop');
  });

  test('the apex mints as the zone itself, with no label in front of it', async () => {
    const { appId } = await seed();
    const result = await setAppVanity({ appId, label: '@' }, context());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'apps.example.test',
    ]);
  });

  test('clearing drops the App back to having no shared name at all', async () => {
    const { appId } = await seed();
    await setAppVanity({ appId, label: 'shop' }, context());
    const result = await setAppVanity({ appId, label: null }, context());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.vanity).toBeNull();
    expect(result.value.hostnames).toEqual(['shop-web.apps.example.test']);
  });
});

describe("setAppVanity under kthx's zone", () => {
  test('reserves the canonical and vanity labels for the App before the write', async () => {
    const { appId } = await seed();
    const seen: (string | null | undefined)[] = [];
    const kthx = new FakeKthx();
    const reserve = kthx.reserve.bind(kthx);
    kthx.reserve = async (holder, labels) => {
      seen.push(await vanityOf(appId));
      return reserve(holder, labels);
    };

    const result = await setAppVanity(
      { appId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(seen).toEqual([null]);
    expect(await vanityOf(appId)).toBe('shop');
  });

  test('a label a kthx site holds is refused, and nothing is written', async () => {
    const { appId } = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop', by: 'site' }] });

    const result = await setAppVanity(
      { appId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    const rule = `would take shop.${KTHX_ZONE}, which a kthx site holds`;
    expect(result.failure.message).toBe(`'shop' ${rule}`);
    expect(result.failure.issues).toEqual([{ path: 'label', message: rule }]);
    expect(await vanityOf(appId)).toBeNull();
  });

  test('a label another App holds is refused with its own sentence', async () => {
    const { appId } = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop', by: 'app' }] });

    const result = await setAppVanity(
      { appId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toBe(
      `'shop' would take shop.${KTHX_ZONE}, which another App holds`,
    );
    expect(await vanityOf(appId)).toBeNull();
  });

  test('kthx not answering refuses the edit and leaves the row as it was', async () => {
    const { appId } = await seed();
    const kthx = new FakeKthx({ unreadable: 'kthx did not answer within 5s' });

    const result = await setAppVanity(
      { appId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toBe(
      `kthx could not reserve shop.${KTHX_ZONE}, shop-web.${KTHX_ZONE} (kthx did not answer within 5s); nothing changed`,
    );
    expect(await vanityOf(appId)).toBeNull();
  });

  test('changing or clearing the label never releases the old one', async () => {
    const { appId } = await seed();
    const kthx = new FakeKthx();

    for (const label of ['shop', 'store', null]) {
      const result = await setAppVanity({ appId, label }, kthxContext(kthx));
      expect(result.ok).toBe(true);
    }

    expect(kthx.released).toEqual([]);
    expect(kthx.reserved.map((call) => call.labels)).toEqual([
      ['shop', 'shop-web'],
      ['shop-web', 'store'],
    ]);
  });

  test('clearing mints no name, so it needs no answer from kthx', async () => {
    const { appId } = await seed();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, appId));

    for (const kthx of [
      new FakeKthx({ unreadable: 'kthx did not answer within 5s' }),
      new FakeKthx({ taken: [{ name: 'shop-web', by: 'app' }] }),
    ]) {
      const result = await setAppVanity(
        { appId, label: null },
        kthxContext(kthx),
      );
      expect(result.ok).toBe(true);
      expect(kthx.calls).toEqual([]);
    }
    expect(await vanityOf(appId)).toBeNull();
  });

  test("names outside kthx's zone make no call", async () => {
    const { appId } = await seed();
    const kthx = new FakeKthx();

    const result = await setAppVanity(
      { appId, label: 'shop' },
      kthxContext(kthx, manifest),
    );

    expect(result.ok).toBe(true);
    expect(kthx.calls).toEqual([]);
  });
});
