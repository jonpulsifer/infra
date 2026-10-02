/** The read side of the Storage contract, one function per method. */
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Page,
  Seq,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord,
} from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import {
  addressColumns,
  materializeDocument,
  scopeColumns,
} from './documents.ts';
import {
  cursorAfter,
  decode,
  indexed,
  int,
  page,
  type RecordRow,
} from './rows.ts';

type AnyTask = TaskRecord<never, never, never>;

export async function readConversation(
  sql: SQL,
  sessionId: string,
  id: ConversationId,
): Promise<ConversationRecord | undefined> {
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_conversations
    WHERE session_id = ${sessionId} AND id = ${id}
  `;
  return row === undefined ? undefined : decode(row);
}

export async function scanConversations(
  sql: SQL,
  sessionId: string,
  query: ConversationQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<Page<ConversationRecord, Cursor>> {
  const rows: RecordRow[] = await sql`
    SELECT record FROM pi_conversations
    WHERE session_id = ${sessionId} AND id > ${cursorAfter(cursor) ?? -1}
      ${query.ownerConversationId === undefined ? sql`` : sql`AND owner_conversation_id = ${query.ownerConversationId}`}
      ${query.ownerTaskId === undefined ? sql`` : sql`AND owner_task_id = ${query.ownerTaskId}`}
    ORDER BY id LIMIT ${limit + 1}
  `;
  return page(
    rows.map((row) => decode<ConversationRecord>(row)),
    limit,
  );
}

interface EntryRow extends RecordRow {
  commit_seq: string;
}

export async function readEntry(
  sql: SQL,
  sessionId: string,
  conversationId: ConversationId | undefined,
  id: EntryId,
): Promise<{ entry: EntryRecord; commitSeq: Seq } | undefined> {
  let conversation: ConversationRecord | undefined;
  if (conversationId !== undefined) {
    conversation = await readConversation(sql, sessionId, conversationId);
    if (conversation === undefined) {
      throw new Error(`Unknown conversation: ${conversationId}`);
    }
  }
  const [row]: EntryRow[] = await sql`
    SELECT record, commit_seq FROM pi_entries
    WHERE session_id = ${sessionId} AND id = ${id}
  `;
  if (row === undefined) return undefined;
  const entry = decode<EntryRecord>(row);
  if (conversation !== undefined) {
    let upper = Number.POSITIVE_INFINITY;
    while (conversation.id !== entry.conversationId) {
      if (conversation.parent === undefined) return undefined;
      upper = Math.min(upper, conversation.parent.at);
      conversation = (await readConversation(
        sql,
        sessionId,
        conversation.parent.conversationId,
      ))!;
    }
    if (entry.id > upper) return undefined;
  }
  return { entry, commitSeq: int(row.commit_seq, 'commit_seq') as Seq };
}

export async function findLatestHeadMarker(
  sql: SQL,
  sessionId: string,
  conversationId: ConversationId,
  atOrBefore: EntryId | undefined,
): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
  let conversation = await readConversation(sql, sessionId, conversationId);
  if (conversation === undefined) {
    throw new Error(`Unknown conversation: ${conversationId}`);
  }
  let upper: number | undefined = atOrBefore;
  for (;;) {
    const [row]: RecordRow[] = await sql`
      SELECT record FROM pi_entries
      WHERE session_id = ${sessionId} AND conversation_id = ${conversation.id}
        AND head IS NOT NULL
        ${upper === undefined ? sql`` : sql`AND id <= ${upper}`}
      ORDER BY id DESC LIMIT 1
    `;
    if (row !== undefined) {
      return decode<EntryRecord & { readonly head: EntryId }>(row);
    }
    if (conversation.parent === undefined) return undefined;
    upper = Math.min(upper ?? conversation.parent.at, conversation.parent.at);
    conversation = (await readConversation(
      sql,
      sessionId,
      conversation.parent.conversationId,
    ))!;
  }
}

export async function scanEntries(
  sql: SQL,
  sessionId: string,
  query: EntryQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<Page<EntryRecord, Cursor>> {
  let conversation = await readConversation(
    sql,
    sessionId,
    query.conversationId,
  );
  if (conversation === undefined) {
    throw new Error(`Unknown conversation: ${query.conversationId}`);
  }
  const after = cursorAfter(cursor);
  let upper: number | undefined = query.maxEntryId;
  if (after !== undefined) {
    upper = Math.min(upper ?? Number.MAX_SAFE_INTEGER, after - 1);
  }
  const values: EntryRecord[] = [];
  for (;;) {
    const rows: RecordRow[] = await sql`
      SELECT record FROM pi_entries
      WHERE session_id = ${sessionId} AND conversation_id = ${conversation.id}
        ${query.minEntryId === undefined ? sql`` : sql`AND id >= ${query.minEntryId}`}
        ${upper === undefined ? sql`` : sql`AND id <= ${upper}`}
      ORDER BY id DESC LIMIT ${limit + 1 - values.length}
    `;
    values.push(...rows.map((row) => decode<EntryRecord>(row)));
    if (values.length > limit || conversation.parent === undefined) break;
    upper = Math.min(upper ?? conversation.parent.at, conversation.parent.at);
    if (query.minEntryId !== undefined && upper < query.minEntryId) break;
    conversation = (await readConversation(
      sql,
      sessionId,
      conversation.parent.conversationId,
    ))!;
  }
  return page(values, limit);
}

export async function readTask(
  sql: SQL,
  sessionId: string,
  id: TaskId,
): Promise<AnyTask | undefined> {
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_tasks WHERE session_id = ${sessionId} AND id = ${id}
  `;
  return row === undefined ? undefined : decode(row);
}

export async function scanTasks(
  sql: SQL,
  sessionId: string,
  query: TaskQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<Page<AnyTask, Cursor>> {
  const rows: RecordRow[] = await sql`
    SELECT record FROM pi_tasks
    WHERE session_id = ${sessionId} AND id > ${cursorAfter(cursor) ?? -1}
      ${query.conversationId === undefined ? sql`` : sql`AND conversation_id = ${query.conversationId}`}
      ${query.kind === undefined ? sql`` : sql`AND kind = ${indexed(query.kind)}`}
      ${query.status === undefined ? sql`` : sql`AND status = ${query.status}`}
      ${query.abortRequested === undefined ? sql`` : sql`AND abort_requested = ${query.abortRequested}`}
      ${query.background === undefined ? sql`` : sql`AND background = ${query.background}`}
    ORDER BY id LIMIT ${limit + 1}
  `;
  return page(
    rows.map((row) => decode<AnyTask>(row)),
    limit,
  );
}

export async function readSubmission(
  sql: SQL,
  sessionId: string,
  id: SubmissionId,
): Promise<SubmissionRecord | undefined> {
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_submissions
    WHERE session_id = ${sessionId} AND id = ${id}
  `;
  return row === undefined ? undefined : decode(row);
}

export async function scanSubmissions(
  sql: SQL,
  sessionId: string,
  query: SubmissionQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<Page<SubmissionRecord, Cursor>> {
  const rows: RecordRow[] = await sql`
    SELECT record FROM pi_submissions
    WHERE session_id = ${sessionId} AND id > ${cursorAfter(cursor) ?? -1}
      ${query.conversationId === undefined ? sql`` : sql`AND conversation_id = ${query.conversationId}`}
      ${query.status === undefined ? sql`` : sql`AND status = ${query.status}`}
    ORDER BY id LIMIT ${limit + 1}
  `;
  return page(
    rows.map((row) => decode<SubmissionRecord>(row)),
    limit,
  );
}

export async function submissionByRequest(
  sql: SQL,
  sessionId: string,
  conversationId: ConversationId,
  requestId: string,
): Promise<SubmissionRecord | undefined> {
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_submissions
    WHERE session_id = ${sessionId} AND conversation_id = ${conversationId}
      AND request_id = ${indexed(requestId)}
    ORDER BY id LIMIT 1
  `;
  return row === undefined ? undefined : decode(row);
}

export async function findDocument(
  sql: SQL,
  sessionId: string,
  address: DocumentAddress,
  at: DocumentPoint,
): Promise<DocumentRecord | undefined> {
  const column = addressColumns(address);
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_documents
    WHERE session_id = ${sessionId} AND kind = ${column.kind}
      AND scope_kind = ${column.scopeKind} AND owner_id = ${column.ownerId}
      AND family = ${column.family} AND key_value = ${column.keyValue}
      ${
        at === 'current'
          ? sql`AND retired_at IS NULL`
          : sql`AND created_at <= ${at} AND (retired_at IS NULL OR retired_at > ${at})`
      }
    ORDER BY created_at DESC LIMIT 1
  `;
  return row === undefined ? undefined : decode(row);
}

export function readDocument(
  sql: SQL,
  sessionId: string,
  id: StoredDocument['record']['id'],
  at: DocumentPoint,
): Promise<StoredDocument | undefined> {
  return sql.begin('isolation level repeatable read read only', (tx) =>
    materializeDocument(tx, sessionId, id, at),
  );
}

export async function scanDocuments(
  sql: SQL,
  sessionId: string,
  query: DocumentQuery,
  limit: number,
  cursor: Cursor | undefined,
): Promise<Page<DocumentRecord, Cursor>> {
  const { scopeKind, ownerId } = scopeColumns(query.scope);
  const rows: RecordRow[] = await sql`
    SELECT record FROM pi_documents
    WHERE session_id = ${sessionId} AND scope_kind = ${scopeKind}
      AND owner_id = ${ownerId} AND id > ${cursorAfter(cursor) ?? -1}
      ${query.kind === undefined ? sql`` : sql`AND kind = ${indexed(query.kind)}`}
      ${
        query.at === 'current'
          ? sql`AND retired_at IS NULL`
          : sql`AND created_at <= ${query.at} AND (retired_at IS NULL OR retired_at > ${query.at})`
      }
    ORDER BY id LIMIT ${limit + 1}
  `;
  return page(
    rows.map((row) => decode<DocumentRecord>(row)),
    limit,
  );
}
