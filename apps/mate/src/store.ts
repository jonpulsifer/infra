/**
 * mate-db: pi's sessions, mate's `mate_threads`, `mate_credentials` and
 * `mate_slack_events`, over one pool. A store that cannot be reached leaves
 * mate up with every open refused, never in a crash loop.
 */

import { migrate } from '@repo/pi-store-postgres';
import { SQL } from 'bun';
import { type Clock, systemClock } from './clock.ts';
import type { BrainConfig } from './config.ts';
import type { SandboxGoneReason } from './lease.ts';
import { type Log, plain } from './log.ts';
import type { Instruments } from './metrics.ts';
import { DEFAULT_PROFILE } from './profiles.ts';
import { type SurfaceName, type ThreadRef, threadKey } from './surface.ts';
import type {
  ThreadListFilter,
  ThreadRow,
  ThreadRowPatch,
  ThreadStore,
  TurnMark,
} from './thread-store.ts';

export const DB_POOL_MAX = 8;
export const MIGRATE_RETRY_MS = 30_000;
/** Shutdown waits this long for queries in flight, then closes the pool anyway. */
export const CLOSE_TIMEOUT_S = 5;
/**
 * Startup parameters on every pool connection: an orphaned transaction holds
 * a session's locks for at most 20 s, and no wait on them outlives 30 s.
 */
export const SESSION_TIMEOUTS = {
  idle_in_transaction_session_timeout: '20s',
  lock_timeout: '30s',
  statement_timeout: '60s',
} as const;

/**
 * Everything but TLS, which `openDatabase` always adds. Bun counts
 * `idleTimeout` as silence on the socket, even while a query waits on it, so
 * it is also the client's bound on a server that stops answering: a stalled
 * commit fails after 30 s and faults its harness.
 */
export const POOL_OPTIONS = {
  max: DB_POOL_MAX,
  idleTimeout: 30,
  maxLifetime: 1_800,
  connectionTimeout: 10,
  connection: SESSION_TIMEOUTS,
};

export interface Database {
  /** `null` when no URL or CA was given: the store stays down for good. */
  readonly sql: SQL | null;
  /** True once the migrations have run. */
  up(): boolean;
  /** Resolves when the store comes up; never rejects. */
  readonly ready: Promise<void>;
  close(): Promise<void>;
}

/** `DATABASE_URL` with its TLS mode forced to verify the server against the CA. */
export function composeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('sslmode', 'verify-full');
  return parsed.toString();
}

export interface OpenDatabaseOptions {
  clock?: Clock;
  metrics?: Pick<Instruments, 'storeFailed'>;
  retryMs?: number;
  closeTimeoutS?: number;
}

/**
 * Opens the pool and migrates in the background, retrying until it works.
 * Nothing here throws: a missing URL or CA is an error log and a store that
 * stays down.
 */
export async function openDatabase(
  config: Pick<BrainConfig, 'databaseUrl' | 'databaseCaFile'>,
  log: Log,
  options: OpenDatabaseOptions = {},
): Promise<Database> {
  const clock = options.clock ?? systemClock;
  let ready = () => {};
  const readyPromise = new Promise<void>((resolve) => {
    ready = resolve;
  });
  if (!config.databaseUrl) {
    log.error('no DATABASE_URL; every thread is refused until one is set');
    return down(readyPromise);
  }
  let ca: string;
  try {
    ca = await Bun.file(config.databaseCaFile).text();
  } catch (error) {
    log.error('the database CA could not be read; the store stays down', {
      caFile: config.databaseCaFile,
      error: plain(error),
    });
    return down(readyPromise);
  }
  const sql = new SQL(composeUrl(config.databaseUrl), {
    ...POOL_OPTIONS,
    tls: { ca },
  });
  let up = false;
  let closed = false;
  const attempt = async (): Promise<void> => {
    if (closed) return;
    try {
      await migrate(sql);
      await migrateThreads(sql);
      up = true;
      log.info('the store is up');
      ready();
    } catch (error) {
      options.metrics?.storeFailed('migrate');
      log.error('the store could not be migrated; retrying', {
        error: storeError(error),
      });
      clock.after(options.retryMs ?? MIGRATE_RETRY_MS, () => void attempt());
    }
  };
  void attempt();
  return {
    sql,
    up: () => up,
    ready: readyPromise,
    close: async () => {
      closed = true;
      await sql.close({ timeout: options.closeTimeoutS ?? CLOSE_TIMEOUT_S });
    },
  };
}

/**
 * A pool error as one line. Bun rejects a server certificate that does not
 * name the URL's host with an empty message, which alone would log nothing.
 */
export function storeError(error: unknown): string {
  const text = plain(error);
  if (text) return text;
  const code = field(error, 'code');
  return `the connection failed with no message${code ? ` (${code})` : ''}: TLS verification or a closed connection; check that the server certificate (Secret mate-db-server) names the DATABASE_URL host`;
}

function down(ready: Promise<void>): Database {
  return { sql: null, up: () => false, ready, close: async () => {} };
}

export const MIGRATIONS: readonly (readonly [number, string])[] = [
  [
    1,
    `CREATE TABLE mate_threads (
      key TEXT COLLATE "C" PRIMARY KEY,
      surface TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      state TEXT NOT NULL,
      session_id TEXT COLLATE "C" NOT NULL,
      quarantined TEXT NOT NULL DEFAULT '[]',
      sandbox TEXT NULL,
      workspace_reset TEXT NULL,
      turns INTEGER NOT NULL DEFAULT 0,
      turn_asker TEXT NULL,
      turn_channel TEXT NULL,
      turn_message TEXT NULL,
      turn_started_at BIGINT NULL,
      turn_resumes INTEGER NULL,
      created_at BIGINT NOT NULL,
      updated_at BIGINT NOT NULL
    );
    CREATE INDEX mate_threads_state ON mate_threads (state, updated_at)`,
  ],
  // `credential` is pi's Credential as JSON. The nightly dump leaves this
  // table's rows out (database-backup.yaml).
  [
    2,
    `CREATE TABLE mate_credentials (
      provider TEXT COLLATE "C" PRIMARY KEY,
      credential TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    )`,
  ],
  [
    3,
    `CREATE TABLE mate_custodian_runs (
      day TEXT COLLATE "C" PRIMARY KEY,
      thread_ts TEXT NULL,
      created_at BIGINT NOT NULL
    )`,
  ],
  // `profile` is written only by the INSERT in `open`, so a thread keeps the
  // profile it was born with; NULL is a row from before profiles, the default.
  [
    4,
    `ALTER TABLE mate_threads ADD COLUMN profile TEXT COLLATE "C" NULL;
    CREATE TABLE mate_profile_turns (
      profile TEXT COLLATE "C" NOT NULL,
      day TEXT COLLATE "C" NOT NULL,
      turns INTEGER NOT NULL,
      PRIMARY KEY (profile, day)
    )`,
  ],
  [
    5,
    `CREATE TABLE mate_slack_events (
      event_id TEXT COLLATE "C" PRIMARY KEY,
      event_time BIGINT NOT NULL,
      claimed_at BIGINT NOT NULL
    );
    CREATE INDEX mate_slack_events_claimed ON mate_slack_events (claimed_at)`,
  ],
  // One pending wake a thread (wakes.ts); `pr` NULL is a timed wake.
  [
    6,
    `CREATE TABLE mate_wakes (
      key TEXT COLLATE "C" PRIMARY KEY,
      surface TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      asker TEXT NOT NULL,
      note TEXT NOT NULL,
      due_at BIGINT NOT NULL,
      pr INTEGER NULL,
      created_at BIGINT NOT NULL
    )`,
  ],
];

/** mate's own tables beside pi's; idempotent and safe to race. */
export async function migrateThreads(sql: SQL): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('mate_migrations'))`;
    await tx`CREATE TABLE IF NOT EXISTS mate_migrations (
      version INTEGER PRIMARY KEY,
      applied_at BIGINT NOT NULL
    )`;
    const done = new Set(
      (await tx`SELECT version FROM mate_migrations`).map(
        (row: { version: number }) => row.version,
      ),
    );
    for (const [version, statements] of MIGRATIONS) {
      if (done.has(version)) continue;
      await tx.unsafe(statements);
      await tx`INSERT INTO mate_migrations (version, applied_at)
        VALUES (${version}, ${Date.now()})`;
    }
  });
}

interface Row {
  key: string;
  surface: string;
  channel_id: string;
  thread_id: string;
  state: string;
  session_id: string;
  quarantined: string;
  sandbox: string | null;
  workspace_reset: string | null;
  turns: number;
  turn_asker: string | null;
  turn_channel: string | null;
  turn_message: string | null;
  turn_started_at: string | number | null;
  turn_resumes: number | null;
  profile: string | null;
  created_at: string | number;
  updated_at: string | number;
}

/** Bun returns a BIGINT as a string. */
function int(value: string | number, column: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error(`mate_threads.${column} is not a safe integer: ${value}`);
  }
  return number;
}

function toRow(row: Row): ThreadRow {
  const turn: TurnMark | null =
    row.turn_asker !== null &&
    row.turn_channel !== null &&
    row.turn_message !== null &&
    row.turn_started_at !== null
      ? {
          asker: row.turn_asker,
          message: { channelId: row.turn_channel, id: row.turn_message },
          startedAt: int(row.turn_started_at, 'turn_started_at'),
          resumes: row.turn_resumes ?? 0,
        }
      : null;
  return {
    key: row.key,
    ref: {
      surface: row.surface as SurfaceName,
      channelId: row.channel_id,
      id: row.thread_id,
    },
    state: row.state === 'closed' ? 'closed' : 'open',
    sessionId: row.session_id,
    quarantined: JSON.parse(row.quarantined) as string[],
    sandbox: row.sandbox,
    workspaceReset: row.workspace_reset as SandboxGoneReason | null,
    turns: row.turns,
    turn,
    profile: row.profile ?? DEFAULT_PROFILE,
    createdAt: int(row.created_at, 'created_at'),
    updatedAt: int(row.updated_at, 'updated_at'),
  };
}

/** The columns a patch writes, by the patch's own keys. */
function columns(patch: ThreadRowPatch): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  if (patch.state !== undefined) set.state = patch.state;
  if (patch.sessionId !== undefined) set.session_id = patch.sessionId;
  if (patch.quarantined !== undefined) {
    set.quarantined = JSON.stringify(patch.quarantined);
  }
  if (patch.sandbox !== undefined) set.sandbox = patch.sandbox;
  if (patch.workspaceReset !== undefined) {
    set.workspace_reset = patch.workspaceReset;
  }
  if (patch.turns !== undefined) set.turns = patch.turns;
  if (patch.turn !== undefined) {
    const turn = patch.turn;
    set.turn_asker = turn?.asker ?? null;
    set.turn_channel = turn?.message.channelId ?? null;
    set.turn_message = turn?.message.id ?? null;
    set.turn_started_at = turn?.startedAt ?? null;
    set.turn_resumes = turn?.resumes ?? null;
  }
  return set;
}

export class PostgresThreadStore implements ThreadStore {
  constructor(
    private readonly sql: SQL,
    private readonly clock: Clock = systemClock,
  ) {}

  async get(key: string): Promise<ThreadRow | undefined> {
    const [row]: Row[] = await this
      .sql`SELECT * FROM mate_threads WHERE key = ${key}`;
    return row ? toRow(row) : undefined;
  }

  async open(ref: ThreadRef, profile: string): Promise<ThreadRow> {
    const key = threadKey(ref);
    const now = this.clock.now();
    const [row]: Row[] = await this.sql`
      INSERT INTO mate_threads (key, surface, channel_id, thread_id, state,
        session_id, profile, created_at, updated_at)
      VALUES (${key}, ${ref.surface}, ${ref.channelId}, ${ref.id}, 'open',
        ${key}, ${profile}, ${now}, ${now})
      ON CONFLICT (key) DO UPDATE SET state = 'open', updated_at = ${now}
      RETURNING *
    `;
    if (!row) throw new Error(`mate_threads refused ${key}`);
    return toRow(row);
  }

  async patch(key: string, patch: ThreadRowPatch): Promise<void> {
    const set = { ...columns(patch), updated_at: this.clock.now() };
    await this.sql`UPDATE mate_threads SET ${this.sql(set)} WHERE key = ${key}`;
  }

  async list(filter: ThreadListFilter): Promise<ThreadRow[]> {
    const rows: Row[] = await this.sql`
      SELECT * FROM mate_threads
      WHERE (${filter.state ?? null}::text IS NULL OR state = ${filter.state ?? null})
        AND (${filter.surface ?? null}::text IS NULL OR surface = ${filter.surface ?? null})
      ORDER BY created_at, key
    `;
    return rows.map(toRow);
  }

  async claimTurn(profile: string, day: string, cap: number): Promise<boolean> {
    const rows = await this.sql`
      INSERT INTO mate_profile_turns (profile, day, turns)
      VALUES (${profile}, ${day}, 1)
      ON CONFLICT (profile, day) DO UPDATE
        SET turns = mate_profile_turns.turns + 1
        WHERE mate_profile_turns.turns < ${cap}
      RETURNING turns
    `;
    return rows.length > 0;
  }

  async closedBefore(
    before: number,
    limit: number,
    profiles: readonly string[],
  ): Promise<ThreadRow[]> {
    // `IN ()` is not SQL.
    if (profiles.length === 0) return [];
    const rows: Row[] = await this.sql`
      SELECT * FROM mate_threads
      WHERE state = 'closed' AND updated_at < ${before}
        AND COALESCE(profile, ${DEFAULT_PROFILE}) IN ${this.sql(profiles)}
      ORDER BY updated_at, key
      LIMIT ${limit}
    `;
    return rows.map(toRow);
  }

  async deleteClosed(
    key: string,
    before: number,
  ): Promise<ThreadRow | undefined> {
    const [row]: Row[] = await this.sql`
      DELETE FROM mate_threads
      WHERE key = ${key} AND state = 'closed' AND updated_at < ${before}
      RETURNING *
    `;
    return row ? toRow(row) : undefined;
  }

  async delete(key: string): Promise<void> {
    await this.sql`DELETE FROM mate_threads WHERE key = ${key}`;
  }
}

/** The same contract in memory: mate with no database, and the thread tests. */
export class MemoryThreadStore implements ThreadStore {
  private readonly rows = new Map<string, ThreadRow>();
  /** Turns counted by `${profile}\n${day}`. */
  private readonly claimTurns = new Map<string, number>();

  constructor(private readonly clock: Clock = systemClock) {}

  async get(key: string): Promise<ThreadRow | undefined> {
    return this.rows.get(key);
  }

  async open(ref: ThreadRef, profile: string): Promise<ThreadRow> {
    const key = threadKey(ref);
    const now = this.clock.now();
    const known = this.rows.get(key);
    const row: ThreadRow = known
      ? { ...known, state: 'open', updatedAt: now }
      : {
          key,
          ref,
          state: 'open',
          sessionId: key,
          quarantined: [],
          sandbox: null,
          workspaceReset: null,
          turns: 0,
          turn: null,
          profile,
          createdAt: now,
          updatedAt: now,
        };
    this.rows.set(key, row);
    return row;
  }

  async patch(key: string, patch: ThreadRowPatch): Promise<void> {
    const row = this.rows.get(key);
    if (!row) return;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    );
    this.rows.set(key, { ...row, ...defined, updatedAt: this.clock.now() });
  }

  async list(filter: ThreadListFilter): Promise<ThreadRow[]> {
    return [...this.rows.values()].filter(
      (row) =>
        (!filter.state || row.state === filter.state) &&
        (!filter.surface || row.ref.surface === filter.surface),
    );
  }

  async claimTurn(profile: string, day: string, cap: number): Promise<boolean> {
    const key = `${profile}\n${day}`;
    const turns = this.claimTurns.get(key) ?? 0;
    if (turns >= cap) return false;
    this.claimTurns.set(key, turns + 1);
    return true;
  }

  async closedBefore(
    before: number,
    limit: number,
    profiles: readonly string[],
  ): Promise<ThreadRow[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.state === 'closed' &&
          row.updatedAt < before &&
          profiles.includes(row.profile),
      )
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit);
  }

  async deleteClosed(
    key: string,
    before: number,
  ): Promise<ThreadRow | undefined> {
    const row = this.rows.get(key);
    if (row?.state !== 'closed' || row.updatedAt >= before) return;
    this.rows.delete(key);
    return row;
  }

  async delete(key: string): Promise<void> {
    this.rows.delete(key);
  }
}

/** Longer than the socket's replay window, so no event it answers was forgotten. */
export const EVENT_CLAIM_KEEP_MS = 86_400_000;
export const EVENT_PRUNE_MS = 3_600_000;

/**
 * The Slack events a process has handled, by event id. A claim is atomic
 * across processes, so an event Slack redelivers after a restart, or to a
 * second replica, is answered once.
 */
export class PostgresEventClaims {
  private prunedAt: number | null = null;

  constructor(
    private readonly sql: SQL,
    private readonly clock: Clock = systemClock,
  ) {}

  async claim(eventId: string, eventTime: number): Promise<boolean> {
    const now = this.clock.now();
    if (this.prunedAt === null || now - this.prunedAt >= EVENT_PRUNE_MS) {
      this.prunedAt = now;
      await this.sql`DELETE FROM mate_slack_events
        WHERE claimed_at < ${now - EVENT_CLAIM_KEEP_MS}`;
    }
    const rows = await this.sql`
      INSERT INTO mate_slack_events (event_id, event_time, claimed_at)
      VALUES (${eventId}, ${eventTime}, ${now})
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id
    `;
    return rows.length > 0;
  }
}

/** Postgres error classes that mean "not reachable right now". */
const UNAVAILABLE_SQLSTATE = /^(08|57P0[123]$|53300$)/;
const CONNECTION_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_POSTGRES_CONNECTION_CLOSED',
  'ERR_POSTGRES_CONNECTION_FAILED',
  'ERR_POSTGRES_CONNECTION_REFUSED',
  'ERR_POSTGRES_CONNECTION_TIMEOUT',
  'ERR_POSTGRES_IDLE_TIMEOUT',
  'ERR_POSTGRES_LIFETIME_TIMEOUT',
  'ERR_POSTGRES_TLS_NOT_AVAILABLE',
  'ERR_POSTGRES_TLS_UPGRADE_FAILED',
]);

function field(error: unknown, key: string): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * True when the store could not be reached: a connection-class SQLSTATE, or
 * Bun failing to connect or losing the connection. It reads `cause` first,
 * as pi wraps a storage error in a `HarnessFault`.
 */
export function isStoreUnavailable(error: unknown): boolean {
  const inner =
    typeof error === 'object' && error !== null && 'cause' in error
      ? ((error as { cause: unknown }).cause ?? error)
      : error;
  for (const candidate of new Set([inner, error])) {
    const sqlState = field(candidate, 'errno');
    if (sqlState && UNAVAILABLE_SQLSTATE.test(sqlState)) return true;
    const code = field(candidate, 'code');
    if (code && CONNECTION_CODES.has(code)) return true;
  }
  return false;
}
