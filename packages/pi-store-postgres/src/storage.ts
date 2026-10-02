/**
 * pi-durable's Storage for one session on Postgres. Each commit is one
 * transaction that holds the session's advisory lock and its row, so one
 * writer at a time assigns seqs, whichever process it runs in. Commits from
 * one instance run in the order they were admitted.
 */
import type { Context } from '@earendil-works/chord';
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from '@earendil-works/pi-durable';
import { StorageRejected } from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { applyCommit, prepareCommit } from './commit.ts';
import * as reads from './reads.ts';
import { isTransient, retrying } from './retry.ts';
import { int } from './rows.ts';

/**
 * A commit this Storage made or tried may have been lost, or may have landed
 * without it learning so: the session is not at the seq the Storage expects,
 * or the retries ran out while an attempt may have committed. The session is
 * consistent either way; reopen it to learn which.
 */
export class CommitOutcomeUnknownError extends Error {
  readonly sessionId: string;
  /** The seq the session was at when this Storage last knew it. */
  readonly firstSeq: number;
  /** Where the session was instead, when a commit read it. */
  readonly foundSeq: number | undefined;

  constructor(
    sessionId: string,
    firstSeq: number,
    found: { seq: number } | { cause: unknown },
  ) {
    super(
      'seq' in found
        ? `pi-store: session ${sessionId} is at seq ${found.seq}, not seq ${firstSeq} where this storage left it`
        : `pi-store: session ${sessionId} ran out of retries after a commit at seq ${firstSeq} may have committed`,
      'cause' in found ? { cause: found.cause } : undefined,
    );
    this.name = 'CommitOutcomeUnknownError';
    this.sessionId = sessionId;
    this.firstSeq = firstSeq;
    this.foundSeq = 'seq' in found ? found.seq : undefined;
  }
}

/**
 * The first seq of an attempt that failed once it sent COMMIT, until a later
 * attempt finds next_seq still there.
 */
interface Doubt {
  firstSeq?: number;
}

export function postgresStorage(
  sql: SQL,
  sessionId: string,
  nextSeq?: number,
): Storage {
  return new PostgresStorage(sql, sessionId, nextSeq);
}

class PostgresStorage implements Storage {
  private readonly sql: SQL;
  private readonly sessionId: string;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly admitted = new Set<Promise<unknown>>();
  private open = true;
  private closing: Promise<void> | undefined;
  /**
   * The next_seq this Storage last read or left under the session's locks.
   * A session has one writer, so any other value means a commit was lost,
   * such as an asynchronous one in a crash, or one landed that this Storage
   * could not confirm.
   */
  private nextSeq: number | undefined;

  constructor(sql: SQL, sessionId: string, nextSeq?: number) {
    this.sql = sql;
    this.sessionId = sessionId;
    this.nextSeq = nextSeq;
  }

  commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
    if (!this.open) {
      return Promise.reject(new StorageRejected(this.closedError().message));
    }
    return this.admit(() => {
      const result = this.tail.then(() => this.commitWithRetry(writes));
      this.tail = result.catch(() => {});
      return result;
    });
  }

  mintId<I extends Id<string>>(): Promise<I> {
    return this.admit(async () => {
      const [row]: { id: string }[] = await retrying(
        () => this.sql`
          UPDATE pi_sessions SET next_id = next_id + 1
          WHERE id = ${this.sessionId} AND next_id <= ${Number.MAX_SAFE_INTEGER}
          RETURNING next_id - 1 AS id
        `,
      );
      if (row !== undefined) return int(row.id, 'id') as I;
      if (!(await this.exists())) throw this.unknownSession();
      throw new Error('ID space is exhausted');
    });
  }

  conversation(
    id: ConversationId,
    _context: Context,
  ): Promise<ConversationRecord | undefined> {
    return this.read((sql) => reads.readConversation(sql, this.sessionId, id));
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.read((sql) =>
      reads.scanConversations(sql, this.sessionId, query, limit, cursor),
    );
  }

  entry(
    id: EntryId,
    context: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined>;
  entry(
    first: EntryId | ConversationId,
    second: EntryId | Context,
    _context?: Context,
  ): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
    const scoped = typeof second === 'number';
    return this.read((sql) =>
      reads.readEntry(
        sql,
        this.sessionId,
        scoped ? (first as ConversationId) : undefined,
        scoped ? second : (first as EntryId),
      ),
    );
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.read((sql) =>
      reads.findLatestHeadMarker(
        sql,
        this.sessionId,
        conversationId,
        atOrBeforeEntryId,
      ),
    );
  }

  scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return this.read((sql) =>
      reads.scanEntries(sql, this.sessionId, query, limit, cursor),
    );
  }

  task(
    id: TaskId,
    _context: Context,
  ): Promise<TaskRecord<never, never, never> | undefined> {
    return this.read((sql) => reads.readTask(sql, this.sessionId, id));
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<TaskRecord<never, never, never>, Cursor>> {
    return this.read((sql) =>
      reads.scanTasks(sql, this.sessionId, query, limit, cursor),
    );
  }

  submission(
    id: SubmissionId,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.read((sql) => reads.readSubmission(sql, this.sessionId, id));
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.read((sql) =>
      reads.scanSubmissions(sql, this.sessionId, query, limit, cursor),
    );
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return this.read((sql) =>
      reads.submissionByRequest(sql, this.sessionId, conversationId, requestId),
    );
  }

  findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    _context: Context,
  ): Promise<DocumentRecord | undefined> {
    return this.read((sql) =>
      reads.findDocument(sql, this.sessionId, address, at),
    );
  }

  document(
    id: DocumentId,
    at: DocumentPoint,
    _context: Context,
  ): Promise<StoredDocument | undefined> {
    return this.read((sql) => reads.readDocument(sql, this.sessionId, id, at));
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.read((sql) =>
      reads.scanDocuments(sql, this.sessionId, query, limit, cursor),
    );
  }

  close(_context: Context): Promise<void> {
    this.closing ??= this.drain();
    return this.closing;
  }

  private async drain(): Promise<void> {
    this.open = false;
    await Promise.allSettled([...this.admitted]);
  }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.open) return Promise.reject(this.closedError());
    const running = operation();
    const tracked = running.then(
      () => undefined,
      () => undefined,
    );
    this.admitted.add(tracked);
    void tracked.then(() => this.admitted.delete(tracked));
    return running;
  }

  private read<T>(query: (sql: SQL) => Promise<T>): Promise<T> {
    return this.admit(() => retrying(() => query(this.sql)));
  }

  private async exists(): Promise<boolean> {
    const [row] = await retrying(
      () => this.sql`
        SELECT EXISTS (SELECT 1 FROM pi_sessions WHERE id = ${this.sessionId})
          AS present
      `,
    );
    return row.present;
  }

  /**
   * Retries only a commit whose earlier attempts provably did not commit: a
   * retry takes the session's locks, which waits out any attempt still in
   * flight, and proceeds only while next_seq is where this Storage expects
   * it. Every failure that provably left nothing behind is a StorageRejected,
   * after which pi-durable's Session carries on. Running out of retries while
   * an attempt may have committed leaves the outcome unknown, which poisons
   * the Session so the host reopens it.
   */
  private async commitWithRetry(writes: readonly StorageWrite[]): Promise<Seq> {
    const doubt: Doubt = {};
    try {
      const prepared = prepareCommit(writes);
      return await retrying(() => this.attempt(prepared, doubt));
    } catch (error) {
      if (error instanceof CommitOutcomeUnknownError) throw error;
      if (doubt.firstSeq !== undefined) {
        throw new CommitOutcomeUnknownError(this.sessionId, doubt.firstSeq, {
          cause: error,
        });
      }
      if (!isTransient(error)) throw error;
      throw new StorageRejected(
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }

  private async attempt(
    prepared: ReturnType<typeof prepareCommit>,
    doubt: Doubt,
  ): Promise<Seq> {
    const id = this.sessionId;
    let left = 0;
    const seq = await this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      const [session]: { next_seq: string }[] = await tx`
        SELECT next_seq FROM pi_sessions WHERE id = ${id} FOR UPDATE
      `;
      if (session === undefined) throw this.unknownSession();
      const firstSeq = int(session.next_seq, 'next_seq');
      const expected = this.nextSeq;
      this.nextSeq = firstSeq;
      if (expected !== undefined && firstSeq !== expected) {
        throw new CommitOutcomeUnknownError(id, expected, { seq: firstSeq });
      }
      doubt.firstSeq = undefined;

      await applyCommit(tx, id, prepared, firstSeq);
      left = firstSeq + 1;
      await tx`
        UPDATE pi_sessions
        SET next_seq = ${left}, next_id = GREATEST(next_id, ${prepared.nextId})
        WHERE id = ${id}
      `;
      doubt.firstSeq = firstSeq;
      return firstSeq as Seq;
    });
    this.nextSeq = left;
    return seq;
  }

  private closedError(): Error {
    return new Error('PostgresStorage is closed');
  }

  private unknownSession(): Error {
    return new Error(`pi-store: unknown session ${this.sessionId}`);
  }
}
