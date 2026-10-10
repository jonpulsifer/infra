import type { SessionInfo } from '@discordjs/ws';
import { type Log, plain } from './log.ts';
import type { Database } from './store.ts';

export interface SessionStore {
  retrieve(shardId: number): Promise<SessionInfo | null>;
  update(shardId: number, info: SessionInfo | null): Promise<void>;
  /**
   * Ignores every later `update`: the library wipes the session when it closes
   * the socket, and a dispatch it reads once the listener has stopped
   * delivering must not move the sequence past a message nobody handled.
   * Synchronous, so it lands before the socket closes.
   */
  seal(): void;
  /** Writes what the debounce still holds. */
  flush(): Promise<void>;
}

const WRITE_DEBOUNCE_MS = 1_000;
const READY_WAIT_MS = 5_000;

export interface PostgresSessionOptions {
  /** How long `retrieve` waits for the migrations before identifying fresh. */
  readyWaitMs?: number;
  debounceMs?: number;
}

type SessionDatabase = Pick<Database, 'sql' | 'up' | 'ready'>;

// `mate_gateway_session` outlives the pod, so a replaced mate resumes the
// previous one's session and Discord replays what arrived in between. Writes
// are debounced: the sequence changes on every dispatch.
export function postgresSessionStore(
  database: SessionDatabase,
  log: Log,
  options: PostgresSessionOptions = {},
): SessionStore {
  const debounceMs = options.debounceMs ?? WRITE_DEBOUNCE_MS;
  let pending: { shardId: number; info: SessionInfo } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sealed = false;
  let warned = false;
  // The library reads the session on every dispatch and heartbeat, so only
  // the first read touches Postgres; `update` keeps the copy current.
  let current: SessionInfo | null = null;
  let first: Promise<SessionInfo | null> | null = null;

  function failed(what: string, error: unknown): void {
    if (warned) return;
    warned = true;
    log.warn(`gateway session ${what} failed`, { error: plain(error) });
  }

  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const write = pending;
    pending = null;
    const { sql } = database;
    if (!write || !sql) return;
    try {
      await sql`INSERT INTO mate_gateway_session (shard_id, info, updated_at)
        VALUES (${write.shardId}, ${JSON.stringify(write.info)}::jsonb, now())
        ON CONFLICT (shard_id) DO UPDATE SET info = EXCLUDED.info,
          updated_at = EXCLUDED.updated_at`;
    } catch (error) {
      failed('write', error);
    }
  }

  async function waitUntilUp(): Promise<void> {
    if (database.up()) return;
    let cancel = () => {};
    const timeout = new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, options.readyWaitMs ?? READY_WAIT_MS);
      cancel = () => clearTimeout(handle);
    });
    await Promise.race([database.ready, timeout]);
    cancel();
  }

  async function load(shardId: number): Promise<SessionInfo | null> {
    await waitUntilUp();
    const { sql } = database;
    if (!sql || !database.up()) {
      log.warn('gateway session store is down; identifying fresh');
      return null;
    }
    try {
      const rows = (await sql`SELECT info FROM mate_gateway_session
      WHERE shard_id = ${shardId}`) as { info: SessionInfo | string }[];
      const info = rows[0]?.info;
      if (!info) {
        log.info('no stored gateway session; identifying fresh');
        return null;
      }
      return typeof info === 'string'
        ? (JSON.parse(info) as SessionInfo)
        : info;
    } catch (error) {
      log.warn('gateway session unreadable; identifying fresh', {
        error: plain(error),
      });
      return null;
    }
  }

  return {
    retrieve(shardId) {
      first ??= load(shardId).then((info) => {
        current = info;
        return info;
      });
      return first.then(() => current);
    },
    async update(shardId, info) {
      if (sealed) return;
      if (info === null) {
        current = null;
        first ??= Promise.resolve(null);
        pending = null;
        if (timer) clearTimeout(timer);
        timer = null;
        const { sql } = database;
        if (!sql) return;
        try {
          await sql`DELETE FROM mate_gateway_session WHERE shard_id = ${shardId}`;
        } catch (error) {
          failed('delete', error);
        }
        return;
      }
      current = info;
      first ??= Promise.resolve(info);
      pending = { shardId, info };
      if (!timer) timer = setTimeout(() => void flush(), debounceMs);
    },
    seal() {
      sealed = true;
    },
    flush,
  };
}

export function memorySessionStore(): SessionStore {
  let current: SessionInfo | null = null;
  let sealed = false;
  return {
    retrieve: async () => current,
    update: async (_shardId, info) => {
      if (sealed) return;
      current = info;
    },
    seal: () => {
      sealed = true;
    },
    flush: async () => {},
  };
}
