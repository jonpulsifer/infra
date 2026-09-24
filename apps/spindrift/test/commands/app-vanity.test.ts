/**
 * An App names its own flat, shared name (§9, ticket 137).
 *
 * `setAppZone` has no dedicated command test of its own — see its module
 * comment — so this is not a mirror of one; it is the direct proof that
 * `setAppVanity` writes what it says and previews what a Deploy will now mint,
 * on every adapter rather than only where the platform names its own.
 */
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
    // None mints a clash in this App's own zone today; a zone declared
    // later, or a reach flipped to public, would.
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
    // The canonical is still minted, exactly as it was before this command —
    // ticket 137 is the vanity riding beside it, not replacing it.
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
