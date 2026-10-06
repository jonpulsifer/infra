/**
 * Commands against a real Postgres, asserting the rows they write. The clock is
 * frozen, so a matching timestamp proves the handler read the context's clock.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { createApp } from '../../src/commands/create-app.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import { apps } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { fixtureManifest } from '../harness/installation.ts';

const manifest = await fixtureManifest();

const database = withIsolatedDatabase();

const FROZEN = new Date('2024-03-05T11:22:33.000Z');
const frozenClock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => {
    throw new Error('no store adapter is configured for this test');
  },
  repository: () => null,
  supplyChain: () => {
    throw new Error('smoke command reached the supply chain');
  },
};

function context(clock: Clock = frozenClock): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

async function appRow(id: string) {
  const rows = await database().db.select().from(apps).where(eq(apps.id, id));
  return rows[0];
}

describe('createApp: an App sourced from a repository', () => {
  test('writes the App row the caller described', async () => {
    const name = `web-${crypto.randomUUID().slice(0, 8)}`;
    const result = await createApp(
      {
        name,
        sourceKind: 'repo',
        repoUrl: 'https://git.example.test/acme/website.git',
        subpath: 'services/api',
      },
      context(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await appRow(result.value.appId);
    expect(row).toBeDefined();
    expect(row?.name).toBe(name);
    expect(row?.sourceKind).toBe('repo');
    expect(row?.sourceRepoUrl).toBe(
      'https://git.example.test/acme/website.git',
    );
    expect(row?.sourceRepoSubpath).toBe('services/api');
    // An App has one source.
    expect(row?.sourceArchiveDigest).toBeNull();
  });

  test('stamps both timestamps from the injected clock', async () => {
    const result = await createApp(
      {
        name: `api-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'repo',
        repoUrl: 'https://git.example.test/acme/api.git',
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await appRow(result.value.appId);
    expect(row?.createdAt.toISOString()).toBe(FROZEN.toISOString());
    expect(row?.updatedAt.toISOString()).toBe(FROZEN.toISOString());
    expect(result.value.createdAt.toISOString()).toBe(FROZEN.toISOString());
  });

  test('leaves an unnamed subpath, vessel, and vanity name unset', async () => {
    const result = await createApp(
      {
        name: `plain-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'repo',
        repoUrl: 'https://git.example.test/acme/plain.git',
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await appRow(result.value.appId);
    expect(row?.sourceRepoSubpath).toBeNull();
    expect(row?.vanityDomain).toBeNull();
  });
});

describe('createApp: an App sourced from an uploaded archive', () => {
  test('records the bundle digest and no repository', async () => {
    const digest = `sha256:${'a1b2c3d4'.repeat(8)}`;
    const result = await createApp(
      {
        name: `bundle-${crypto.randomUUID().slice(0, 8)}`,
        sourceKind: 'archive',
        archiveDigest: digest,
        vanityDomain: 'notes',
      },
      context(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = await appRow(result.value.appId);
    expect(row?.sourceKind).toBe('archive');
    expect(row?.sourceArchiveDigest).toBe(digest);
    expect(row?.sourceRepoUrl).toBeNull();
    expect(row?.vanityDomain).toBe('notes');
  });
});

describe('dispatch: the public command boundary', () => {
  test('reads a row written through an internal command', async () => {
    const name = `listed-${crypto.randomUUID().slice(0, 8)}`;
    const created = await createApp(
      {
        name,
        sourceKind: 'repo',
        repoUrl: 'https://git.example.test/acme/listed.git',
      },
      context(),
    );
    expect(created.ok).toBe(true);

    const result = await dispatch('listApps', {}, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const value = result.value as { apps: { name: string }[] };
    expect(value.apps.some((app) => app.name === name)).toBe(true);
  });

  test('writes nothing when the input does not satisfy the schema', async () => {
    const before = await database().db.select().from(apps);

    const result = await dispatch(
      'startCreationDraft',
      { id: 'not a uuid' },
      context(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('INVALID_INPUT');

    const after = await database().db.select().from(apps);
    expect(after.length).toBe(before.length);
  });
});
