/**
 * One Apps list: built Apps first, then kthx's sites. kthx being absent or
 * down never costs the built rows.
 */
import { describe, expect, test } from 'bun:test';
import type { KthxClient, KthxSite } from '../../src/adapters/kthx.ts';
import { listApps } from '../../src/commands/apps/list.ts';
import { listAppRows } from '../../src/commands/apps/rows.ts';
import { createComponent } from '../../src/commands/components/create.ts';
import { createApp } from '../../src/commands/create-app.ts';
import { dispatch } from '../../src/commands/registry.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
  PrincipalKind,
} from '../../src/commands/types.ts';
import type { AppRowView } from '../../src/commands/views.ts';
import {
  builds,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const manifest = await fixtureManifest();
const database = withIsolatedDatabase();

const FROZEN = new Date('2026-09-30T12:10:00.000Z');
const clock: Clock = { now: () => FROZEN };

const ACME: KthxSite = {
  name: 'acme',
  url: 'https://acme.kthx.test',
  owner: 'someone@example.com',
  serving: 7,
  held: true,
  created: '2026-09-30T12:00:00.000Z',
  deployed: '2026-09-30T12:05:00.000Z',
  provisioned: true,
};

const FRESH: KthxSite = {
  name: 'fresh',
  url: 'https://fresh.kthx.test',
  owner: null,
  serving: null,
  held: false,
  created: '2026-09-30T12:01:00.000Z',
  deployed: null,
  provisioned: false,
};

type ListSites = KthxClient['listSites'];

function fakeKthx(listSites: ListSites) {
  const calls: Parameters<ListSites>[0][] = [];
  const client: KthxClient = {
    zone: 'kthx.test',
    listSites: (page) => {
      calls.push(page);
      return listSites(page);
    },
    getSite: () => {
      throw new Error('the list read one site');
    },
    reserve: () => {
      throw new Error('a read reserved a name');
    },
    release: () => {
      throw new Error('a read released a name');
    },
  };
  return { calls, client };
}

function context(
  kthx: KthxClient | null | undefined,
  kind?: PrincipalKind,
): CommandContext {
  const adapters: AdapterRegistry = {
    deploy: () => null,
    build: () => null,
    store: () => {
      throw new Error('no store adapter is configured for this test');
    },
    repository: () => null,
    supplyChain: () => {
      throw new Error('the App list reached the supply chain');
    },
    ...(kthx === undefined ? {} : { kthx: () => kthx }),
  };
  return {
    principal: {
      id: crypto.randomUUID(),
      displayName: 'Operator',
      ...(kind === undefined ? {} : { kind }),
    },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

/** One App with one LIVE service, so its row carries every optional field. */
async function seedApp(ctx: CommandContext): Promise<string> {
  const app = await createApp(
    {
      name: 'invoices',
      sourceKind: 'repo',
      repoUrl: 'https://vcs.example/acme/invoices.git',
    },
    ctx,
  );
  if (!app.ok) throw new Error(app.failure.message);
  const vessel = await insertVessel(ctx.db, 'kubernetes', { name: 'rack' });
  const [target] = await ctx.db
    .insert(targets)
    .values(targetValues({ adapter: 'kubernetes', vesselId: vessel.id }))
    .returning();
  const created = await createComponent(
    {
      appId: app.value.appId,
      name: 'web',
      kind: 'service',
      expose: true,
      reach: 'private',
      auth: 'proxy',
    },
    ctx,
  );
  if (!created.ok) throw new Error(created.failure.message);
  await ctx.db.insert(componentTargetDesired).values({
    componentId: created.value.componentId,
    targetId: target!.id,
  });
  const [build] = await ctx.db
    .insert(builds)
    .values({
      componentId: created.value.componentId,
      commit: 'abc1234',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: `sha256:${'a'.repeat(64)}`,
      status: 'SUCCEEDED',
    })
    .returning();
  await ctx.db.insert(deploys).values({
    componentId: created.value.componentId,
    desired: aDesiredDocument(),
    targetId: target!.id,
    buildId: build!.id,
    phase: 'LIVE',
    url: 'https://invoices-web.apps.example.test',
    createdAt: new Date('2026-09-30T12:08:00.000Z'),
  });
  return app.value.appId;
}

function kinds(rows: readonly AppRowView[]): string[] {
  return rows.map((row) => row.key);
}

describe('kthx not configured', () => {
  test.each([
    ['no kthx lookup', undefined],
    ['a null kthx', null],
  ])('%s lists built Apps only, with sites off', async (_label, kthx) => {
    const ctx = context(kthx, 'human');
    const appId = await seedApp(ctx);

    const listed = await listAppRows({}, ctx);

    expect(listed).toEqual({
      ok: true,
      value: {
        rows: [expect.objectContaining({ kind: 'app', key: appId })],
        sites: { state: 'off' },
        next: null,
      },
    });
  });

  test('a later page is empty', async () => {
    const ctx = context(null, 'human');
    await seedApp(ctx);
    expect(await listAppRows({ after: 'acme' }, ctx)).toEqual({
      ok: true,
      value: { rows: [], sites: { state: 'off' }, next: null },
    });
  });
});

describe('kthx failing', () => {
  test('built Apps still list, and the reason is carried', async () => {
    const { client } = fakeKthx(async () => ({
      ok: false,
      reason: 'kthx did not answer within 3s',
    }));
    const ctx = context(client, 'human');
    const appId = await seedApp(ctx);

    const listed = await listAppRows({}, ctx);

    if (!listed.ok) throw new Error(listed.failure.message);
    expect(kinds(listed.value.rows)).toEqual([appId]);
    expect(listed.value.sites).toEqual({
      state: 'unreadable',
      reason: 'kthx did not answer within 3s',
    });
    expect(listed.value.next).toBeNull();
  });
});

describe('kthx answering', () => {
  test('page 1 holds the built Apps, then a page of sites', async () => {
    const { calls, client } = fakeKthx(async () => ({
      ok: true,
      value: { total: 3, items: [ACME, FRESH], next: 'fresh' },
    }));
    const ctx = context(client, 'human');
    const appId = await seedApp(ctx);

    const listed = await listAppRows({}, ctx);

    if (!listed.ok) throw new Error(listed.failure.message);
    expect(calls).toEqual([{ after: null, limit: 50 }]);
    expect(kinds(listed.value.rows)).toEqual([
      appId,
      'site:acme',
      'site:fresh',
    ]);
    expect(listed.value.sites).toEqual({ state: 'ok', total: 3 });
    expect(listed.value.next).toBe('fresh');
    expect(listed.value.rows[1]).toEqual({
      kind: 'site',
      key: 'site:acme',
      site: {
        name: 'acme',
        url: 'https://acme.kthx.test',
        owner: 'someone@example.com',
        release: 7,
        held: true,
        createdAt: '2026-09-30T12:00:00.000Z',
        at: '2026-09-30T12:05:00.000Z',
        when: '5m ago',
      },
    });
    expect(listed.value.rows[2]).toEqual({
      kind: 'site',
      key: 'site:fresh',
      site: {
        name: 'fresh',
        url: 'https://fresh.kthx.test',
        owner: null,
        release: null,
        held: false,
        createdAt: '2026-09-30T12:01:00.000Z',
      },
    });
  });

  test('a later page holds sites only, from the cursor', async () => {
    const { calls, client } = fakeKthx(async () => ({
      ok: true,
      value: { total: 3, items: [FRESH], next: null },
    }));
    const ctx = context(client, 'human');
    await seedApp(ctx);

    const listed = await listAppRows({ after: 'acme', limit: 1 }, ctx);

    if (!listed.ok) throw new Error(listed.failure.message);
    expect(calls).toEqual([{ after: 'acme', limit: 1 }]);
    expect(kinds(listed.value.rows)).toEqual(['site:fresh']);
    expect(listed.value.next).toBeNull();
  });

  test('an agent never sees an owner, not even an anonymous one', async () => {
    for (const kind of ['agent', undefined] as const) {
      const { client } = fakeKthx(async () => ({
        ok: true,
        value: { total: 2, items: [ACME, FRESH], next: null },
      }));
      const listed = await listAppRows({ after: 'a' }, context(client, kind));
      if (!listed.ok) throw new Error(listed.failure.message);
      for (const row of listed.value.rows) {
        if (row.kind !== 'site') throw new Error('an after page held an App');
        expect('owner' in row.site).toBe(false);
      }
    }
  });
});

describe('the built rows are listApps, unchanged', () => {
  test('listApps reads as before, and each app row carries it whole', async () => {
    const { client } = fakeKthx(async () => ({
      ok: true,
      value: { total: 1, items: [ACME], next: null },
    }));
    const ctx = context(client, 'human');
    const appId = await seedApp(ctx);

    const before = await listApps({}, ctx);
    const rows = await listAppRows({}, ctx);

    if (!before.ok || !rows.ok) throw new Error('a list failed');
    expect(before.value).toEqual({
      apps: [
        {
          id: appId,
          name: 'invoices',
          vessel: 'rack',
          source: 'acme/invoices',
          kind: 'service',
          phase: 'LIVE',
          target: 'kubernetes',
          url: 'https://invoices-web.apps.example.test',
          urlLive: true,
          faulty: false,
          componentCount: 1,
          failing: 0,
          commit: 'abc1234',
          commitMessage: null,
          when: '2m ago',
          at: '2026-09-30T12:08:00.000Z',
          deployId: expect.any(Number),
          artifact: expect.any(String),
        },
      ],
    });
    expect(
      rows.value.rows.flatMap((row) => (row.kind === 'app' ? [row.app] : [])),
    ).toEqual([...before.value.apps]);
  });
});

describe('input', () => {
  test('a cursor that is not a site name is refused', async () => {
    for (const after of ['Acme', '-acme', 'a.b', 'x'.repeat(64)]) {
      const result = await dispatch('listAppRows', { after }, context(null));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.failure.code).toBe('INVALID_INPUT');
    }
  });

  test('a limit outside 1..200 is refused', async () => {
    for (const limit of [0, 201, 1.5]) {
      const result = await dispatch('listAppRows', { limit }, context(null));
      expect(result.ok).toBe(false);
    }
  });
});
