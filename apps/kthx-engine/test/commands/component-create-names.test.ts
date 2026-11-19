// `<app>-<component>` names a Component's workload and leads its canonical
// name, so a new Component may not take one another Component already joins to.
import { describe, expect, test } from 'bun:test';
import { count } from 'drizzle-orm';
import {
  createComponent,
  createComponentInput,
} from '../../src/commands/components/create.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { apps, components } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock: { now: () => new Date('2026-11-19T00:00:00.000Z') },
    db: database().db,
    adapters: {
      deploy: () => null,
      build: () => null,
      store: () => null,
      repository: () => null,
      supplyChain: () => {
        throw new Error('createComponent must not reach the supply chain');
      },
    },
    manifest,
  };
}

async function app(name: string): Promise<string> {
  const [row] = await database()
    .db.insert(apps)
    .values({ name, sourceKind: 'archive' })
    .returning();
  return row!.id;
}

async function create(
  appId: string,
  name: string,
  values: { reach?: 'none' | 'private' | 'public' } = {},
) {
  return createComponent(
    createComponentInput.parse({
      appId,
      name,
      kind: 'service',
      auth: 'none',
      ...values,
    }),
    context(),
  );
}

async function componentCount(): Promise<number> {
  const [row] = await database().db.select({ value: count() }).from(components);
  return row!.value;
}

describe('createComponent names', () => {
  test('refuses a join another App already makes, whatever the reach', async () => {
    const first = await create(await app('my-shop'), 'web', { reach: 'none' });
    expect(first.ok).toBe(true);

    const second = await create(await app('my'), 'shop-web');

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.failure.code).toBe('INVALID_INPUT');
    expect(second.failure.message).toBe(
      "'shop-web' my-shop-web is my-shop's web's workload name already",
    );
    expect(second.failure.issues?.[0]?.path).toBe('name');
    expect(await componentCount()).toBe(1);
  });

  test('refuses a join longer than one DNS label', async () => {
    const result = await create(await app('a'.repeat(40)), 'b'.repeat(23));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.issues?.[0]?.path).toBe('name');
    expect(await componentCount()).toBe(0);
  });

  test('a join of exactly 63 characters is a name', async () => {
    const result = await create(await app('a'.repeat(40)), 'b'.repeat(22));

    expect(result.ok).toBe(true);
  });

  test("refuses a canonical name that is another Component's vanity name", async () => {
    const holder = await create(await app('store'), 'front');
    if (!holder.ok) throw new Error(holder.failure.message);
    await database().db.update(components).set({ vanityLabel: 'shop-web' });

    const result = await create(await app('shop'), 'web');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.message).toBe(
      "'web' would take shop-web.apps.example.test, which store's front holds",
    );
  });

  test('two Components of one App, or the same name in two Apps, may differ', async () => {
    const shop = await app('shop');
    expect((await create(shop, 'web')).ok).toBe(true);
    expect((await create(shop, 'api')).ok).toBe(true);
    expect((await create(await app('store'), 'web')).ok).toBe(true);
  });
});
