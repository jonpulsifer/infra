import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { withNamingLock } from '../../src/commands/apps/names.ts';
import { setComponentVanity } from '../../src/commands/components/vanity.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { createDb } from '../../src/db/client.ts';
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
    throw new Error('setComponentVanity must not reach an adapter');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('setComponentVanity must not reach an adapter');
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

async function vanityOf(
  componentId: string,
): Promise<string | null | undefined> {
  const [row] = await database()
    .db.select({ vanityLabel: components.vanityLabel })
    .from(components)
    .where(eq(components.id, componentId));
  return row?.vanityLabel;
}

/** An App with one placed, `private`-reach Component on a cluster Target. */
async function seed(
  values: Partial<typeof components.$inferInsert> = {},
  appId?: string,
): Promise<{ appId: string; componentId: string }> {
  const db = database().db;
  const owner =
    appId ??
    (
      await db
        .insert(apps)
        .values({ name: 'shop', sourceKind: 'archive' })
        .returning()
    )[0]!.id;
  const [component] = await db
    .insert(components)
    .values({
      appId: owner,
      name: 'web',
      kind: 'service',
      expose: true,
      ...values,
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
  return { appId: owner, componentId: component!.id };
}

describe('setComponentVanity', () => {
  test('refuses an unknown Component', async () => {
    const result = await setComponentVanity(
      { componentId: crypto.randomUUID(), label: 'shop' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_FOUND');
  });

  test('refuses a label that is not one DNS label or the apex, and writes nothing', async () => {
    const { componentId } = await seed();
    const result = await setComponentVanity(
      { componentId, label: 'shop.example.test' },
      context(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    expect(result.failure.message).toContain('@');

    expect(await vanityOf(componentId)).toBeNull();
  });

  test("refuses a label that would take the installation's own or reserved names, in any zone", async () => {
    const { componentId } = await seed();
    // None clashes in this App's zone today; a later zone or a public reach
    // would.
    for (const [label, taken] of [
      ['spindrift', manifest.controlPlane.hostname],
      ['spindrift-control', manifest.controlPlane.publicHostname],
      ['kthx', manifest.controlPlane.reservedHostnames[0]],
    ] as const) {
      const result = await setComponentVanity(
        { componentId, label },
        context(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain(taken!);
      expect(result.failure.issues).toEqual([
        { path: 'label', message: expect.stringContaining(taken!) },
      ]);
    }

    expect(await vanityOf(componentId)).toBeNull();
  });

  test('refuses the apex of a zone that is one of those names', async () => {
    const { componentId } = await seed();
    const own = manifest.controlPlane.hostname;
    const result = await setComponentVanity(
      { componentId, label: '@' },
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

  test('a reserved zone apex refuses the apex for an App in any other zone', async () => {
    const { componentId } = await seed();
    const reserved = 'sites.example.test';
    const withReservedZone: CommandContext = {
      ...context(),
      manifest: {
        ...manifest,
        controlPlane: {
          ...manifest.controlPlane,
          reservedHostnames: [
            ...manifest.controlPlane.reservedHostnames,
            reserved,
          ],
        },
        dns: {
          zones: [
            ...manifest.dns.zones,
            { name: reserved, reaches: ['public'] },
          ],
        },
      },
    };

    const apex = await setComponentVanity(
      { componentId, label: '@' },
      withReservedZone,
    );
    expect(apex.ok).toBe(false);
    if (apex.ok) throw new Error('unreachable');
    expect(apex.failure.code).toBe('INVALID_INPUT');
    expect(apex.failure.message).toContain(reserved);

    const label = await setComponentVanity(
      { componentId, label: 'shop' },
      withReservedZone,
    );
    expect(label.ok).toBe(true);
    if (!label.ok) throw new Error('unreachable');
    expect(label.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'shop.apps.example.test',
    ]);
  });

  test('a label that only starts with one of them is its own name', async () => {
    const { componentId } = await seed();
    const result = await setComponentVanity(
      { componentId, label: 'spindrift-shop' },
      context(),
    );
    expect(result.ok).toBe(true);
  });

  test('writes the label and previews the canonical and vanity names side by side', async () => {
    const { componentId } = await seed();
    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.vanity).toBe('shop');
    // The canonical name is still minted beside the vanity.
    expect(result.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'shop.apps.example.test',
    ]);

    expect(await vanityOf(componentId)).toBe('shop');
  });

  test('the apex mints as the zone itself, with no label in front of it', async () => {
    const { componentId } = await seed();
    const result = await setComponentVanity(
      { componentId, label: '@' },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'apps.example.test',
    ]);
  });

  test('clearing drops the Component back to its canonical name alone', async () => {
    const { componentId } = await seed();
    await setComponentVanity({ componentId, label: 'shop' }, context());
    const result = await setComponentVanity(
      { componentId, label: null },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.vanity).toBeNull();
    expect(result.value.hostnames).toEqual(['shop-web.apps.example.test']);
  });
});

describe("setComponentVanity under kthx's zone", () => {
  test('reserves the canonical and vanity labels for the App before the write', async () => {
    const { appId, componentId } = await seed();
    const seen: (string | null | undefined)[] = [];
    const kthx = new FakeKthx();
    const reserve = kthx.reserve.bind(kthx);
    // Another session: the edit's transaction holds the test's one connection.
    const outside = createDb(database().connect());
    kthx.reserve = async (holder, labels) => {
      const [row] = await outside
        .select({ vanityLabel: components.vanityLabel })
        .from(components)
        .where(eq(components.id, componentId));
      seen.push(row?.vanityLabel);
      return reserve(holder, labels);
    };

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(true);
    expect(kthx.reserved).toEqual([
      { holder: appId, labels: ['shop', 'shop-web'] },
    ]);
    expect(seen).toEqual([null]);
    expect(await vanityOf(componentId)).toBe('shop');
  });

  test('a label a kthx site holds is refused, and nothing is written', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop', by: 'site' }] });

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    const rule = `would take shop.${KTHX_ZONE}, which a kthx site holds`;
    expect(result.failure.message).toBe(`'shop' ${rule}`);
    expect(result.failure.issues).toEqual([{ path: 'label', message: rule }]);
    expect(await vanityOf(componentId)).toBeNull();
  });

  test('a label another App holds is refused with its own sentence', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx({ taken: [{ name: 'shop', by: 'app' }] });

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toBe(
      `'shop' would take shop.${KTHX_ZONE}, which another App holds`,
    );
    expect(await vanityOf(componentId)).toBeNull();
  });

  test('kthx not answering refuses the edit and leaves the row as it was', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx({ unreadable: 'kthx did not answer within 5s' });

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      kthxContext(kthx),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toBe(
      `kthx could not reserve shop.${KTHX_ZONE}, shop-web.${KTHX_ZONE} (kthx did not answer within 5s); nothing changed`,
    );
    expect(await vanityOf(componentId)).toBeNull();
  });

  test('changing or clearing the label never releases the old one', async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx();

    for (const label of ['shop', 'store', null]) {
      const result = await setComponentVanity(
        { componentId, label },
        kthxContext(kthx),
      );
      expect(result.ok).toBe(true);
    }

    expect(kthx.released).toEqual([]);
    expect(kthx.reserved.map((call) => call.labels)).toEqual([
      ['shop', 'shop-web'],
      ['shop-web', 'store'],
    ]);
  });

  test('clearing mints no name, so it needs no answer from kthx', async () => {
    const { componentId } = await seed();
    await database()
      .db.update(components)
      .set({ vanityLabel: 'shop' })
      .where(eq(components.id, componentId));

    for (const kthx of [
      new FakeKthx({ unreadable: 'kthx did not answer within 5s' }),
      new FakeKthx({ taken: [{ name: 'shop-web', by: 'app' }] }),
    ]) {
      const result = await setComponentVanity(
        { componentId, label: null },
        kthxContext(kthx),
      );
      expect(result.ok).toBe(true);
      expect(kthx.calls).toEqual([]);
    }
    expect(await vanityOf(componentId)).toBeNull();
  });

  test("names outside kthx's zone make no call", async () => {
    const { componentId } = await seed();
    const kthx = new FakeKthx();

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      kthxContext(kthx, manifest),
    );

    expect(result.ok).toBe(true);
    expect(kthx.calls).toEqual([]);
  });
});

describe('one name belongs to one Component', () => {
  test('two serving Components of one App each take a name of their own', async () => {
    const { appId, componentId: web } = await seed();
    const { componentId: admin } = await seed({ name: 'admin' }, appId);

    const first = await setComponentVanity(
      { componentId: web, label: 'shop' },
      context(),
    );
    const second = await setComponentVanity(
      { componentId: admin, label: 'admin' },
      context(),
    );

    expect(first.ok && first.value.hostnames).toEqual([
      'shop-web.apps.example.test',
      'shop.apps.example.test',
    ]);
    expect(second.ok && second.value.hostnames).toEqual([
      'shop-admin.apps.example.test',
      'admin.apps.example.test',
    ]);
    expect(await vanityOf(web)).toBe('shop');
    expect(await vanityOf(admin)).toBe('admin');
  });

  test('a name another Component holds is refused, naming the holder', async () => {
    const { appId, componentId: web } = await seed({ vanityLabel: 'shop' });
    const { componentId: admin } = await seed({ name: 'admin' }, appId);

    const result = await setComponentVanity(
      { componentId: admin, label: 'shop' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.code).toBe('INVALID_INPUT');
    const rule = "would take shop.apps.example.test, which shop's web holds";
    expect(result.failure.message).toBe(`'shop' ${rule}`);
    expect(result.failure.issues).toEqual([{ path: 'label', message: rule }]);
    expect(await vanityOf(admin)).toBeNull();
    expect(await vanityOf(web)).toBe('shop');
  });

  test('an edit waits for one in flight, then sees the name it took', async () => {
    const { appId, componentId: web } = await seed();
    const { componentId: admin } = await seed({ name: 'admin' }, appId);
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken = () => {};
    const written = new Promise<void>((resolve) => {
      taken = resolve;
    });
    const inFlight = withNamingLock(context(), async (locked) => {
      await locked.db
        .update(components)
        .set({ vanityLabel: 'shop' })
        .where(eq(components.id, web));
      taken();
      await held;
    });
    await written;

    // Another session, or the test's one connection would serialize the two.
    const edit = setComponentVanity(
      { componentId: admin, label: 'shop' },
      { ...context(), db: createDb(database().connect()) },
    );
    await Bun.sleep(50);
    release();
    await inFlight;
    const result = await edit;

    expect(result.ok).toBe(false);
    expect(await vanityOf(admin)).toBeNull();
  });

  test("a label that mints another Component's canonical name is refused", async () => {
    const { componentId } = await seed();
    await seed({ name: 'admin' });

    const result = await setComponentVanity(
      { componentId, label: 'shop-admin' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toContain("which shop's admin holds");
  });

  test('one label in two zones is two names', async () => {
    const { appId } = await seed({ vanityLabel: 'shop' });
    const { componentId } = await seed(
      { name: 'site', kind: 'website', reach: 'public', auth: 'none' },
      appId,
    );

    const result = await setComponentVanity(
      { componentId, label: 'shop' },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.hostnames).toContain('shop.example.test');
  });

  test('a Component that does not serve the network takes no name', async () => {
    for (const values of [
      { name: 'worker', expose: false },
      { name: 'nightly', kind: 'job' as const, expose: null },
    ]) {
      const { componentId } = await seed(values);

      const result = await setComponentVanity(
        { componentId, label: 'shop' },
        context(),
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.failure.code).toBe('INVALID_INPUT');
      expect(result.failure.message).toContain(
        'only a website or an exposed service',
      );
      expect(await vanityOf(componentId)).toBeNull();
    }
  });
});
