/** mate's rows in mate-db, the pool's server-side timeouts, and the store-down classifier. */
import { describe, expect, test } from 'bun:test';
import { CommitOutcomeUnknownError, migrate } from '@repo/pi-store-postgres';
import { SQL } from 'bun';
import { silentLog } from '../src/log.ts';
import {
  composeUrl,
  EVENT_CLAIM_KEEP_MS,
  EVENT_PRUNE_MS,
  isStoreUnavailable,
  MemoryThreadStore,
  MIGRATIONS,
  migrateThreads,
  openDatabase,
  POOL_OPTIONS,
  PostgresEventClaims,
  PostgresThreadStore,
  storeError,
} from '../src/store.ts';
import type { ThreadRef } from '../src/surface.ts';
import type { ThreadStore } from '../src/thread-store.ts';
import { withDatabase } from './db.ts';
import { stallingProxy } from './stall-proxy.ts';
import { FakeClock, RecordingInstruments, RecordingLog } from './support.ts';

const database = withDatabase();

let serial = 0;
function ref(): ThreadRef {
  serial += 1;
  return { surface: 'discord', channelId: 'c1', id: `t${serial}` };
}

function storeAt(clock: FakeClock) {
  return new PostgresThreadStore(database().sql, clock);
}

describe('the migrations', () => {
  test('run twice without harm, and race safely', async () => {
    const { sql } = database();
    await Promise.all([migrateThreads(sql), migrateThreads(sql)]);
    await migrate(sql);
    const [row] = await sql`SELECT count(*)::int AS n FROM mate_migrations`;
    expect(row.n).toBe(MIGRATIONS.length);
  });
});

describe('a thread row', () => {
  test('opens with the key as its session, and reopens keeping what it had', async () => {
    const clock = new FakeClock();
    const store = storeAt(clock);
    const thread = ref();
    const row = await store.open(thread, 'operator');
    expect(row).toMatchObject({
      key: `discord:${thread.id}`,
      ref: thread,
      state: 'open',
      sessionId: `discord:${thread.id}`,
      quarantined: [],
      sandbox: null,
      workspaceReset: null,
      turns: 0,
      turn: null,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    });
    await store.patch(row.key, {
      state: 'closed',
      sessionId: `${row.key}~1`,
      quarantined: [row.key],
      turns: 7,
    });
    await clock.advance(1_000);
    const again = await store.open(thread, 'operator');
    expect(again).toMatchObject({
      state: 'open',
      sessionId: `${row.key}~1`,
      quarantined: [row.key],
      turns: 7,
      createdAt: row.createdAt,
      updatedAt: row.createdAt + 1_000,
    });
  });

  test('a patch writes only the columns it is given, and BIGINTs read back as numbers', async () => {
    const clock = new FakeClock();
    const store = storeAt(clock);
    const row = await store.open(ref(), 'operator');
    const turn = {
      asker: 'u1',
      message: { channelId: 'c1', id: 'm1' },
      startedAt: 1_700_000_000_123,
      resumes: 1,
    };
    await store.patch(row.key, { turn, turns: 3 });
    await store.patch(row.key, { sandbox: 'mate-t', workspaceReset: 'quiet' });
    const read = await store.get(row.key);
    expect(read).toMatchObject({
      turn,
      turns: 3,
      sandbox: 'mate-t',
      workspaceReset: 'quiet',
    });
    expect(typeof read?.turn?.startedAt).toBe('number');
    expect(typeof read?.createdAt).toBe('number');
    await store.patch(row.key, { turn: null });
    expect(await store.get(row.key)).toMatchObject({
      turn: null,
      turns: 3,
      sandbox: 'mate-t',
    });
  });

  test('lists by state and surface', async () => {
    const store = storeAt(new FakeClock());
    const open = await store.open(ref(), 'operator');
    const slack: ThreadRef = {
      surface: 'slack',
      channelId: 'C1',
      id: `1758300000.${++serial}`,
    };
    await store.open(slack, 'operator');
    const closed = await store.open(ref(), 'operator');
    await store.patch(closed.key, { state: 'closed' });
    const discordOpen = await store.list({ state: 'open', surface: 'discord' });
    expect(discordOpen.map((row) => row.key)).toContain(open.key);
    expect(discordOpen.map((row) => row.key)).not.toContain(closed.key);
    expect(
      (await store.list({ surface: 'slack' })).every(
        (row) => row.ref.surface === 'slack',
      ),
    ).toBe(true);
  });

  test('retention finds old closed rows and deletes one only while it is still closed and old', async () => {
    const clock = new FakeClock();
    const store = storeAt(clock);
    const old = await store.open(ref(), 'operator');
    await store.patch(old.key, { state: 'closed' });
    const reopened = await store.open(ref(), 'operator');
    await store.patch(reopened.key, { state: 'closed' });
    const stillOpen = await store.open(ref(), 'operator');
    await clock.advance(60_000);
    const recent = await store.open(ref(), 'operator');
    await store.patch(recent.key, { state: 'closed' });
    const before = clock.now();

    const found = await store.closedBefore(before, 100, ['operator']);
    const keys = found.map((row) => row.key);
    expect(keys).toContain(old.key);
    expect(keys).toContain(reopened.key);
    expect(keys).not.toContain(stillOpen.key);
    expect(keys).not.toContain(recent.key);

    // A reply reopened it between the listing and the delete.
    await store.open(reopened.ref, 'operator');
    expect(await store.deleteClosed(reopened.key, before)).toBeUndefined();
    expect(await store.deleteClosed(recent.key, before)).toBeUndefined();
    expect((await store.deleteClosed(old.key, before))?.key).toBe(old.key);
    expect(await store.get(old.key)).toBeUndefined();
    expect(await store.get(reopened.key)).toBeDefined();
  });

  test('deletes', async () => {
    const store = storeAt(new FakeClock());
    const row = await store.open(ref(), 'operator');
    await store.delete(row.key);
    expect(await store.get(row.key)).toBeUndefined();
  });
});

const stores: [string, (clock: FakeClock) => ThreadStore][] = [
  ['postgres', storeAt],
  ['memory', (clock) => new MemoryThreadStore(clock)],
];

for (const [kind, storeOf] of stores) {
  describe(`profiles in the ${kind} store`, () => {
    test('a row keeps the profile it was born with', async () => {
      const store = storeOf(new FakeClock());
      const thread = ref();
      const row = await store.open(thread, 'investigator');
      expect(row.profile).toBe('investigator');
      await store.patch(row.key, { state: 'closed' });
      const again = await store.open(thread, 'operator');
      expect(again).toMatchObject({ state: 'open', profile: 'investigator' });
      expect((await store.get(row.key))?.profile).toBe('investigator');
    });

    test('a daily cap grants its turns and then refuses, apart for each profile and day', async () => {
      const store = storeOf(new FakeClock());
      const profile = `p${++serial}`;
      expect(await store.claimTurn(profile, '2026-10-01', 2)).toBe(true);
      expect(await store.claimTurn(profile, '2026-10-01', 2)).toBe(true);
      expect(await store.claimTurn(profile, '2026-10-01', 2)).toBe(false);
      expect(await store.claimTurn(profile, '2026-10-02', 2)).toBe(true);
      expect(await store.claimTurn(`${profile}-b`, '2026-10-01', 2)).toBe(true);
    });

    test('claims racing at the cap grant exactly the cap', async () => {
      const store = storeOf(new FakeClock());
      const profile = `p${++serial}`;
      const granted = await Promise.all(
        Array.from({ length: 10 }, () =>
          store.claimTurn(profile, '2026-10-01', 3),
        ),
      );
      expect(granted.filter(Boolean)).toHaveLength(3);
    });

    test('retention finds closed rows of the profiles it is given only', async () => {
      const clock = new FakeClock();
      const store = storeOf(clock);
      const opened = await Promise.all(
        ['operator', 'custodian', 'investigator'].map((profile) =>
          store.open(ref(), profile),
        ),
      );
      for (const row of opened) {
        await store.patch(row.key, { state: 'closed' });
      }
      await clock.advance(1_000);
      const keys = (
        await store.closedBefore(clock.now(), 100, ['operator', 'custodian'])
      ).map((row) => row.key);
      expect(opened.map((row) => keys.includes(row.key))).toEqual([
        true,
        true,
        false,
      ]);
      expect(await store.closedBefore(clock.now(), 100, [])).toEqual([]);
    });
  });
}

describe('a Slack event claim', () => {
  test('is won once across processes, and forgotten a day later', async () => {
    const clock = new FakeClock();
    const one = new PostgresEventClaims(database().sql, clock);
    const two = new PostgresEventClaims(database().sql, clock);
    const id = `Ev${crypto.randomUUID()}`;
    const at = clock.now();
    const raced = await Promise.all([one.claim(id, at), two.claim(id, at)]);
    expect(raced.sort()).toEqual([false, true]);
    expect(await one.claim(id, at)).toBe(false);

    await clock.advance(EVENT_CLAIM_KEEP_MS + EVENT_PRUNE_MS);
    expect(await one.claim(`Ev${crypto.randomUUID()}`, clock.now())).toBe(true);
    expect(await two.claim(id, at)).toBe(true);
  });
});

describe('a row from before profiles', () => {
  test('reads, reopens and is swept as the default profile', async () => {
    const clock = new FakeClock();
    const store = storeAt(clock);
    const thread = ref();
    const key = `discord:${thread.id}`;
    // As an image from before profiles inserts it.
    await database().sql`
      INSERT INTO mate_threads (key, surface, channel_id, thread_id, state,
        session_id, created_at, updated_at)
      VALUES (${key}, 'discord', ${thread.channelId}, ${thread.id}, 'closed',
        ${key}, ${clock.now()}, ${clock.now()})
    `;
    expect((await store.get(key))?.profile).toBe('operator');
    await clock.advance(1_000);
    const swept = await store.closedBefore(clock.now(), 100, ['operator']);
    expect(swept.map((row) => row.key)).toContain(key);
    expect(
      (await store.closedBefore(clock.now(), 100, ['investigator'])).map(
        (row) => row.key,
      ),
    ).not.toContain(key);
    expect((await store.open(thread, 'investigator')).profile).toBe('operator');
  });
});

describe('the pool', () => {
  test('every connection carries the timeouts that bound an orphaned transaction', async () => {
    const sql = new SQL(database().url, POOL_OPTIONS);
    try {
      const show = async (name: string) =>
        (await sql.unsafe(`SHOW ${name}`))[0]?.[name];
      expect(await show('idle_in_transaction_session_timeout')).toBe('20s');
      expect(await show('lock_timeout')).toBe('30s');
      expect(await show('statement_timeout')).toBe('1min');
    } finally {
      await sql.close();
    }
  });

  test('always verifies the server against the CA, whatever the URL says', () => {
    const plain = composeUrl('postgresql://app:pw@mate-db-rw.mate:5432/app');
    expect(new URL(plain).searchParams.get('sslmode')).toBe('verify-full');
    const disabled = composeUrl(
      'postgresql://app:pw@mate-db-rw.mate:5432/app?sslmode=disable&application_name=mate',
    );
    const url = new URL(disabled);
    expect(url.searchParams.getAll('sslmode')).toEqual(['verify-full']);
    expect(url.searchParams.get('application_name')).toBe('mate');
    expect(url.password).toBe('pw');
  });

  test('without a URL or a CA the store stays down, and nothing throws', async () => {
    const log = new RecordingLog();
    const none = await openDatabase(
      { databaseUrl: null, databaseCaFile: '/nope' },
      log,
    );
    expect(none.up()).toBe(false);
    expect(none.sql).toBeNull();
    const noCa = await openDatabase(
      {
        databaseUrl: 'postgresql://app@127.0.0.1:1/app',
        databaseCaFile: '/does/not/exist/ca.crt',
      },
      log,
    );
    expect(noCa.up()).toBe(false);
    expect(log.entries.filter((entry) => entry.level === 'error')).toHaveLength(
      2,
    );
  });

  test('a server that stops answering mid-transaction fails it once the idle timeout passes', async () => {
    const proxy = stallingProxy(database().url);
    // Scaled down from 30 s; Bun counts it as silence on the socket.
    const sql = new SQL(proxy.url, { ...POOL_OPTIONS, idleTimeout: 1 });
    try {
      const started = performance.now();
      const error = await sql
        .begin(async (tx) => {
          await tx`SELECT 1`;
          proxy.freeze();
          await tx`SELECT 2`;
        })
        .then(
          () => null,
          (reason: unknown) => reason,
        );
      expect(performance.now() - started).toBeLessThan(3_000);
      expect(isStoreUnavailable(error)).toBe(true);
    } finally {
      proxy.stop();
      await sql.close({ timeout: 0 });
    }
  });

  test('closing gives up on queries still in flight after its bound', async () => {
    const silent = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: { open() {}, data() {} },
    });
    // Any certificate: the server never gets as far as TLS.
    const ca = `${import.meta.dir}/../../../terraform/pki/certs/fml-root.pem`;
    const db = await openDatabase(
      {
        databaseUrl: `postgresql://app@127.0.0.1:${silent.port}/app`,
        databaseCaFile: ca,
      },
      silentLog,
      { clock: new FakeClock(), closeTimeoutS: 1 },
    );
    try {
      // A pool, not a store that stayed down for want of a CA.
      expect(db.sql).not.toBeNull();
      // The migration waits on a server that never answers.
      await Bun.sleep(100);
      const started = performance.now();
      await db.close();
      expect(performance.now() - started).toBeLessThan(2_500);
    } finally {
      silent.stop(true);
    }
  });

  test('an error with no message still says what to check', () => {
    expect(storeError(new Error('Connection refused'))).toBe(
      'Connection refused',
    );
    // How Bun rejects a server certificate that does not name the host.
    const tls = storeError(Object.assign(new Error(''), { errno: 0 }));
    expect(tls).toContain('TLS verification');
    expect(tls).toContain('DATABASE_URL host');
    expect(
      storeError(Object.assign(new Error(''), { code: 'ERR_X' })),
    ).toContain('(ERR_X)');
  });

  test('a store that cannot migrate retries until it can, and counts each failure', async () => {
    const clock = new FakeClock();
    const metrics = new RecordingInstruments();
    const ca = `${import.meta.dir}/../../../packages/mate-hands/README.md`;
    const db = await openDatabase(
      { databaseUrl: 'postgresql://app@127.0.0.1:1/app', databaseCaFile: ca },
      silentLog,
      { clock, metrics, retryMs: 1_000 },
    );
    for (let i = 0; i < 50 && metrics.storeFailures.length === 0; i += 1) {
      await Bun.sleep(20);
    }
    expect(db.up()).toBe(false);
    expect(metrics.storeFailures).toEqual(['migrate']);
    await db.close();
  });
});

describe('a store that cannot be reached', () => {
  const connection = (errno?: string, code?: string) =>
    Object.assign(new Error('boom'), { errno, code });
  const cases: [string, unknown, boolean][] = [
    ['connection failure (08006)', connection('08006'), true],
    ['admin shutdown (57P01)', connection('57P01'), true],
    ['cannot connect now (57P03)', connection('57P03'), true],
    ['too many connections (53300)', connection('53300'), true],
    [
      'Bun lost the connection',
      connection(undefined, 'ERR_POSTGRES_CONNECTION_CLOSED'),
      true,
    ],
    ['refused', connection(undefined, 'ECONNREFUSED'), true],
    [
      'a failure wrapping a lost connection',
      new Error('fault', { cause: connection('08006') }),
      true,
    ],
    ['a unique violation (23505)', connection('23505'), false],
    ['a query cancelled (57014)', connection('57014'), false],
    ['a plain error', new Error('nope'), false],
    [
      'a commit whose outcome is unknown',
      new CommitOutcomeUnknownError('s', 1, { seq: 2 }),
      false,
    ],
    ['nothing at all', undefined, false],
  ];
  for (const [name, error, unavailable] of cases) {
    test(`${name} → ${unavailable}`, () => {
      expect(isStoreUnavailable(error)).toBe(unavailable);
    });
  }

  test('as Bun reports a refused connection', async () => {
    const sql = new SQL('postgres://postgres@127.0.0.1:1/postgres', {
      max: 1,
      connectionTimeout: 2,
    });
    const error = await sql`SELECT 1`.then(
      () => null,
      (reason: unknown) => reason,
    );
    await sql.close();
    expect(error).not.toBeNull();
    expect(isStoreUnavailable(error)).toBe(true);
  });
});
