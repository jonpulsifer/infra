/**
 * pi's Storage for one session on Postgres. Each commit is one transaction
 * that holds the session's advisory lock and its row, so one writer at a time
 * assigns seqs, whichever process it runs in. Commits from one instance run
 * in the order they were admitted.
 */
import {
  type CommitResult,
  type CommittedWrite,
  type Context,
  type Entry,
  type EntryScan,
  type EntryStructure,
  type ListElement,
  type ListReadOptions,
  prepareStorageCommit,
  resolveListReadOptions,
  type SessionStats,
  type Storage,
  type StorageBranchScan,
  type StoredValue,
  type UsageRow,
  type UsageScan,
  type Value,
  type ValueList,
  validateCommittedWrites,
  value,
  type Write,
} from '@earendil-works/pi-agent-core';
import type { SQL } from 'bun';
import { scanBranchEntries, scanBranchStructures } from './branch.ts';
import { type CommitPlan, isFrameOnly, planCommit } from './plan.ts';
import { ATTEMPTS, backoff, isTransient, retrying } from './retry.ts';
import {
  decodeEntry,
  decodeStructure,
  decodeUsage,
  type EntryRow,
  entryPayload,
  int,
  json,
  pageSize,
  type UsageLedgerRow,
} from './rows.ts';
import { addUsage } from './usage.ts';

/**
 * A commit failed after an earlier attempt of it may have committed. The session
 * is consistent either way; reopen it to learn which.
 */
export class CommitOutcomeUnknownError extends Error {
  readonly sessionId: string;
  readonly firstSeq: number;

  constructor(sessionId: string, firstSeq: number) {
    super(
      `pi-store: session ${sessionId} moved past seq ${firstSeq} after a failed commit attempt claimed it`,
    );
    this.name = 'CommitOutcomeUnknownError';
    this.sessionId = sessionId;
    this.firstSeq = firstSeq;
  }
}

interface SessionRow {
  next_seq: string | number;
  message_count: string | number;
  usage_payload: string;
}

/** What one attempt learned before it failed. */
interface Attempt {
  firstSeq?: number;
}

export function postgresStorage(sql: SQL, sessionId: string): Storage {
  return new PostgresStorage(sql, sessionId);
}

class PostgresStorage implements Storage {
  private readonly sql: SQL;
  private readonly sessionId: string;
  private tail: Promise<unknown> = Promise.resolve();
  private state: 'open' | 'closing' | 'closed' = 'open';
  private closing: Promise<void> | undefined;

  constructor(sql: SQL, sessionId: string) {
    this.sql = sql;
    this.sessionId = sessionId;
  }

  commit(writes: Write[], _context: Context): Promise<CommitResult> {
    if (this.state !== 'open') return Promise.reject(this.closedError());
    const result = this.tail.then(() => this.commitWithRetry(writes));
    this.tail = result.catch(() => {});
    return result;
  }

  getEntries(ids: string[], _context: Context): Promise<Map<string, Entry>> {
    return this.read(async (sql) => {
      if (ids.length === 0) return new Map();
      const rows: EntryRow[] = await sql`
        SELECT id, parent_id, seq, type, custom_type, timestamp, payload
        FROM pi_entries
        WHERE session_id = ${this.sessionId}
          AND id = ANY(${sql.array(ids, 'TEXT')})
      `;
      const byId = new Map(rows.map((row) => [row.id, row]));
      const found = new Map<string, Entry>();
      for (const id of ids) {
        const row = byId.get(id);
        if (row !== undefined) found.set(id, decodeEntry(row));
      }
      return found;
    });
  }

  getValue<T>(
    address: Value<T>,
    _context: Context,
  ): Promise<StoredValue<T> | undefined> {
    return this.read(async (sql) => {
      const [row] = await sql`
        SELECT seq, value FROM pi_scalar_values
        WHERE session_id = ${this.sessionId}
          AND namespace = ${address.namespace}
          AND key = ${address.key}
      `;
      if (row === undefined) return undefined;
      return {
        address,
        value: JSON.parse(row.value),
        seq: int(row.seq, 'seq'),
      };
    });
  }

  scanValues<T>(
    prefix: Value<T>,
    _context: Context,
  ): Promise<StoredValue<T>[]> {
    return this.read(async (sql) => {
      const rows: { key: string; seq: string; value: string }[] = await sql`
        SELECT key, seq, value FROM pi_scalar_values
        WHERE session_id = ${this.sessionId}
          AND namespace = ${prefix.namespace}
          AND starts_with(key, ${prefix.key})
        ORDER BY key
      `;
      return rows.map((row) => ({
        address: value<T>(prefix.namespace, row.key),
        value: JSON.parse(row.value),
        seq: int(row.seq, 'seq'),
      }));
    });
  }

  readList<T>(
    address: ValueList<T>,
    options: ListReadOptions | undefined,
    _context: Context,
  ): Promise<ListElement<T>[]> {
    return this.read(async (sql) => {
      const { cursor, order, limit } = resolveListReadOptions(options);
      const asc = order === 'asc';
      const rows: { seq: string; value: string }[] = await sql`
        SELECT seq, value FROM pi_list_values
        WHERE session_id = ${this.sessionId}
          AND namespace = ${address.namespace}
          AND key = ${address.key}
          ${
            cursor === undefined
              ? sql``
              : asc
                ? sql`AND seq > ${cursor.seq}`
                : sql`AND seq < ${cursor.seq}`
          }
        ORDER BY seq ${asc ? sql`ASC` : sql`DESC`}
        LIMIT ${limit}
      `;
      return rows.map((row) => ({
        seq: int(row.seq, 'seq'),
        value: JSON.parse(row.value),
      }));
    });
  }

  scanBranch(query: StorageBranchScan, _context: Context): Promise<Entry[]> {
    return this.read(async (sql) =>
      (await scanBranchEntries(sql, this.sessionId, query)).map(decodeEntry),
    );
  }

  scanBranchStructure(
    query: StorageBranchScan,
    _context: Context,
  ): Promise<EntryStructure[]> {
    return this.read(async (sql) =>
      (await scanBranchStructures(sql, this.sessionId, query)).map(
        decodeStructure,
      ),
    );
  }

  scanEntries(query: EntryScan, _context: Context): Promise<Entry[]> {
    return this.read(async (sql) => {
      const limit = pageSize(query.limit);
      const rows: EntryRow[] = await sql`
        SELECT id, parent_id, seq, type, custom_type, timestamp, payload
        FROM pi_entries
        WHERE session_id = ${this.sessionId}
          ${query.type === undefined ? sql`` : sql`AND type = ${query.type}`}
          ${query.customType === undefined ? sql`` : sql`AND custom_type = ${query.customType}`}
          ${query.fromSeq === undefined ? sql`` : sql`AND seq >= ${query.fromSeq}`}
          ${query.toSeq === undefined ? sql`` : sql`AND seq <= ${query.toSeq}`}
        ORDER BY seq ${query.order === 'desc' ? sql`DESC` : sql`ASC`}
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
      `;
      return rows.map(decodeEntry);
    });
  }

  scanUsage(query: UsageScan, _context: Context): Promise<UsageRow[]> {
    return this.read(async (sql) => {
      const limit = pageSize(query.limit);
      const rows: UsageLedgerRow[] = await sql`
        SELECT id, seq, entry_id, adjustment, usage, details
        FROM pi_usage_ledger
        WHERE session_id = ${this.sessionId}
          ${query.fromSeq === undefined ? sql`` : sql`AND seq >= ${query.fromSeq}`}
          ${query.toSeq === undefined ? sql`` : sql`AND seq <= ${query.toSeq}`}
        ORDER BY seq ${query.order === 'desc' ? sql`DESC` : sql`ASC`}
        ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
      `;
      return rows.map(decodeUsage);
    });
  }

  getStats(_context: Context): Promise<SessionStats> {
    return this.read(async (sql) => {
      const [row]: SessionRow[] = await sql`
        SELECT next_seq, message_count, usage_payload
        FROM pi_sessions WHERE id = ${this.sessionId}
      `;
      if (row === undefined) throw this.unknownSession();
      return statsOf(row);
    });
  }

  close(_context: Context): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.state = 'closing';
    this.closing = this.tail.then(() => {
      this.state = 'closed';
    });
    return this.closing;
  }

  private read<T>(query: (sql: SQL) => Promise<T>): Promise<T> {
    if (this.state !== 'open') return Promise.reject(this.closedError());
    return retrying(() => query(this.sql));
  }

  /**
   * Retries only a commit whose earlier attempts provably did not commit: the
   * retry takes the session's locks, which waits out any attempt still in
   * flight, and proceeds only while next_seq still equals the first seq an
   * earlier attempt read.
   */
  private async commitWithRetry(writes: Write[]): Promise<CommitResult> {
    let claimed: number | undefined;
    for (let attempt = 1; ; attempt++) {
      const trace: Attempt = {};
      try {
        return await this.attempt(writes, claimed, trace);
      } catch (error) {
        if (attempt >= ATTEMPTS || !isTransient(error)) throw error;
        claimed ??= trace.firstSeq;
        await backoff(attempt);
      }
    }
  }

  private attempt(
    writes: Write[],
    claimed: number | undefined,
    trace: Attempt,
  ): Promise<CommitResult> {
    const id = this.sessionId;
    // No nested fragments on `tx`: when the connection drops, Bun rejects
    // them as queries of their own, and nothing is there to catch it.
    return this.sql.begin(async (tx) => {
      await (isFrameOnly(writes)
        ? tx`
            SELECT pg_advisory_xact_lock(hashtext(${id})),
              set_config('synchronous_commit', 'off', true)
          `
        : tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`);
      const [session]: SessionRow[] = await tx`
        SELECT next_seq, message_count, usage_payload
        FROM pi_sessions WHERE id = ${id}
        FOR UPDATE
      `;
      if (session === undefined) throw this.unknownSession();
      const firstSeq = int(session.next_seq, 'next_seq');
      if (claimed !== undefined && firstSeq !== claimed) {
        throw new CommitOutcomeUnknownError(id, claimed);
      }
      trace.firstSeq = firstSeq;

      const prepared = prepareStorageCommit(writes, firstSeq, Date.now());
      await validate(tx, id, prepared.writes, firstSeq);
      const plan = planCommit(prepared.writes);
      await apply(tx, id, plan);
      const stats = nextStats(statsOf(session), plan);
      await tx`
        UPDATE pi_sessions
        SET next_seq = ${firstSeq + prepared.writes.length},
            message_count = ${stats.messageCount},
            usage_payload = ${json(stats.usage, 'session usage')}
        WHERE id = ${id}
      `;
      return { ...prepared.result, stats };
    });
  }

  private closedError(): Error {
    return new Error('PostgresStorage is closed');
  }

  private unknownSession(): Error {
    return new Error(`pi-store: unknown session ${this.sessionId}`);
  }
}

function statsOf(row: SessionRow): SessionStats {
  return {
    messageCount: int(row.message_count, 'message_count'),
    usage: JSON.parse(row.usage_payload),
  };
}

function nextStats(stats: SessionStats, plan: CommitPlan): SessionStats {
  const messages = plan.entries.filter((entry) => entry.type === 'message');
  return {
    messageCount: stats.messageCount + messages.length,
    usage: plan.usage.reduce(
      (sum, row) => addUsage(sum, row.usage),
      stats.usage,
    ),
  };
}

/** pi's own checks: one id space for entries and usage, and parents first. */
async function validate(
  sql: SQL,
  sessionId: string,
  writes: readonly CommittedWrite[],
  firstSeq: number,
): Promise<void> {
  const ids = new Set<string>();
  for (const write of writes) {
    if (write.kind === 'usage') ids.add(write.id);
    if (write.kind !== 'entry') continue;
    ids.add(write.id);
    if (write.parentId !== null) ids.add(write.parentId);
  }
  const entries = new Set<string>();
  const usage = new Set<string>();
  if (ids.size > 0) {
    const rows: { id: string; entry: boolean }[] = await sql`
      SELECT id, true AS entry FROM pi_entries
      WHERE session_id = ${sessionId} AND id = ANY(${sql.array([...ids], 'TEXT')})
      UNION ALL
      SELECT id, false AS entry FROM pi_usage_ledger
      WHERE session_id = ${sessionId} AND id = ANY(${sql.array([...ids], 'TEXT')})
    `;
    for (const row of rows) (row.entry ? entries : usage).add(row.id);
  }
  validateCommittedWrites(writes, firstSeq, {
    hasEntryOrUsageId: (id) => entries.has(id) || usage.has(id),
    hasEntryId: (id) => entries.has(id),
  });
}

/**
 * Rows travel as one JSON document per statement: Bun's array parameters
 * cannot carry SQL nulls, and one parameter never meets Postgres's limit.
 */
async function apply(
  sql: SQL,
  sessionId: string,
  plan: CommitPlan,
): Promise<void> {
  if (plan.valueDeletes.length > 0) {
    await sql`
      DELETE FROM pi_scalar_values v
      USING json_to_recordset(${JSON.stringify(plan.valueDeletes)}::text::json)
        AS d(namespace text, key text)
      WHERE v.session_id = ${sessionId}
        AND v.namespace = d.namespace AND v.key = d.key
    `;
  }
  if (plan.valueSets.length > 0) {
    await sql`
      INSERT INTO pi_scalar_values (session_id, namespace, key, seq, value)
      SELECT ${sessionId}, namespace, key, seq, value
      FROM json_to_recordset(${JSON.stringify(plan.valueSets)}::text::json)
        AS r(namespace text, key text, seq bigint, value text)
      ON CONFLICT (session_id, namespace, key)
      DO UPDATE SET seq = excluded.seq, value = excluded.value
    `;
  }
  if (plan.listDeletes.length > 0) {
    await sql`
      DELETE FROM pi_list_values l
      USING json_to_recordset(${JSON.stringify(plan.listDeletes)}::text::json)
        AS d(namespace text, key text)
      WHERE l.session_id = ${sessionId}
        AND l.namespace = d.namespace AND l.key = d.key
    `;
  }
  if (plan.listAppends.length > 0) {
    await sql`
      INSERT INTO pi_list_values (session_id, namespace, key, seq, value)
      SELECT ${sessionId}, namespace, key, seq, value
      FROM json_to_recordset(${JSON.stringify(plan.listAppends)}::text::json)
        AS r(namespace text, key text, seq bigint, value text)
    `;
  }
  if (plan.entries.length > 0) {
    const rows = plan.entries.map((entry) => ({
      id: entry.id,
      parent_id: entry.parentId,
      seq: entry.seq,
      type: entry.type,
      custom_type: entry.customType ?? null,
      timestamp: entry.timestamp,
      payload: entryPayload(entry),
    }));
    await sql`
      INSERT INTO pi_entries
        (session_id, id, parent_id, seq, type, custom_type, timestamp, payload)
      SELECT ${sessionId}, id, parent_id, seq, type, custom_type, timestamp, payload
      FROM json_to_recordset(${JSON.stringify(rows)}::text::json)
        AS r(id text, parent_id text, seq bigint, type text,
             custom_type text, timestamp bigint, payload text)
    `;
  }
  if (plan.usage.length > 0) {
    const rows = plan.usage.map((row) => ({
      id: row.id,
      seq: row.seq,
      entry_id: row.entryId ?? null,
      adjustment: row.adjustment,
      usage: json(row.usage, `usage ${row.id}`),
      details:
        row.details === undefined ? null : json(row.details, `usage ${row.id}`),
    }));
    await sql`
      INSERT INTO pi_usage_ledger
        (session_id, id, seq, entry_id, adjustment, usage, details)
      SELECT ${sessionId}, id, seq, entry_id, adjustment, usage, details
      FROM json_to_recordset(${JSON.stringify(rows)}::text::json)
        AS r(id text, seq bigint, entry_id text, adjustment boolean,
             usage text, details text)
    `;
  }
}
