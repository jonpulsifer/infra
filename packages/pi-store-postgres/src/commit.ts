/**
 * The write side of the Storage contract: pi-durable's checks and the table
 * writes of one commit, run inside the transaction storage.ts opens. Rows
 * travel as one JSON document per statement: Bun's array parameters cannot
 * carry SQL nulls, and one parameter never meets Postgres's limit.
 */
import {
  type DocumentContent,
  type DocumentCopySource,
  type DocumentCreate,
  type DocumentId,
  type DocumentRecord,
  StorageRejected,
  type StorageWrite,
} from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import {
  addressColumns,
  isCurrentOnly,
  materializeDocument,
} from './documents.ts';
import { decode, indexed, int, json, type RecordRow } from './rows.ts';

interface DocumentAction {
  create?: DocumentCreate;
  copy?: DocumentCopySource;
  content?: DocumentContent;
  retire: boolean;
}

type TableWrite = Extract<
  StorageWrite,
  { type: 'conversation' | 'entry' | 'task' | 'submission' }
>;

export interface PreparedCommit {
  readonly tables: readonly TableWrite[];
  readonly actions: ReadonlyMap<DocumentId, DocumentAction>;
  /** One past the highest id the commit writes. */
  readonly nextId: number;
}

/** Folds the batch's document writes into one action per document. */
export function prepareCommit(writes: readonly StorageWrite[]): PreparedCommit {
  const tables: TableWrite[] = [];
  const actions = new Map<DocumentId, DocumentAction>();
  let nextId = 0;
  const action = (id: DocumentId): DocumentAction => {
    let found = actions.get(id);
    if (found === undefined) {
      found = { retire: false };
      actions.set(id, found);
    }
    return found;
  };
  const single = (id: DocumentId, found: DocumentAction, creates: boolean) => {
    if (
      found.content !== undefined ||
      found.copy !== undefined ||
      (creates && found.create !== undefined)
    ) {
      throw new Error(`Document ${id} has more than one content command`);
    }
  };
  for (const write of writes) {
    switch (write.type) {
      case 'conversation':
      case 'entry':
      case 'task':
      case 'submission':
        tables.push(write);
        nextId = Math.max(nextId, write.value.id + 1);
        break;
      case 'document.create': {
        const found = action(write.record.id);
        single(write.record.id, found, true);
        found.create = write.record;
        found.content = write.content;
        nextId = Math.max(nextId, write.record.id + 1);
        break;
      }
      case 'document.copy': {
        const found = action(write.record.id);
        single(write.record.id, found, true);
        found.create = write.record;
        found.copy = write.source;
        nextId = Math.max(nextId, write.record.id + 1);
        break;
      }
      case 'document.change': {
        const found = action(write.id);
        single(write.id, found, false);
        found.content = write.content;
        break;
      }
      case 'document.retire': {
        const found = action(write.id);
        if (found.retire) {
          throw new Error(`Document ${write.id} is retired more than once`);
        }
        found.retire = true;
        break;
      }
    }
  }
  return { tables, actions, nextId };
}

export async function applyCommit(
  tx: SQL,
  sessionId: string,
  prepared: PreparedCommit,
  seq: number,
): Promise<void> {
  const existing = await checkRecordIds(tx, sessionId, prepared);
  await writeTables(tx, sessionId, prepared.tables, seq);
  await writeDocuments(tx, sessionId, prepared.actions, existing, seq);
}

/** Claims every id the batch creates, refusing one that already belongs. */
async function checkRecordIds(
  tx: SQL,
  sessionId: string,
  prepared: PreparedCommit,
): Promise<Map<DocumentId, DocumentRecord>> {
  const claims: { id: number; type: string }[] = [];
  for (const write of prepared.tables) {
    claims.push({ id: write.value.id, type: write.type });
  }
  for (const action of prepared.actions.values()) {
    if (action.create !== undefined) {
      claims.push({ id: action.create.id, type: 'document' });
    }
  }
  const owned = new Map<number, string>();
  if (claims.length > 0) {
    const rows: { id: string; record_type: string }[] = await tx`
      SELECT r.id, r.record_type FROM pi_record_ids r
      JOIN json_to_recordset(${JSON.stringify(claims.map((c) => ({ id: c.id })))}::text::json)
        AS q(id bigint) ON r.id = q.id
      WHERE r.session_id = ${sessionId}
    `;
    for (const row of rows) owned.set(int(row.id, 'id'), row.record_type);
  }
  const claimed = new Map<number, string>();
  for (const { id, type } of claims) {
    const before = owned.get(id);
    const earlier = claimed.get(id);
    const shared = type === 'task' || type === 'submission';
    if (before !== undefined && (!shared || before !== type)) {
      throw new Error(`ID ${id} already belongs to ${before}`);
    }
    if (earlier !== undefined) {
      if (!shared) throw new Error(`ID ${id} is written more than once`);
      if (earlier !== type) {
        throw new Error(`ID ${id} is written as two record types`);
      }
    }
    claimed.set(id, type);
  }
  if (claimed.size > 0) {
    const rows = [...claimed].map(([id, type]) => ({ id, record_type: type }));
    await tx`
      INSERT INTO pi_record_ids (session_id, id, record_type)
      SELECT ${sessionId}, id, record_type
      FROM json_to_recordset(${JSON.stringify(rows)}::text::json)
        AS r(id bigint, record_type text)
      ON CONFLICT DO NOTHING
    `;
  }
  return checkDocuments(tx, sessionId, prepared.actions);
}

/** Validates the document actions and returns the records they change. */
async function checkDocuments(
  tx: SQL,
  sessionId: string,
  actions: ReadonlyMap<DocumentId, DocumentAction>,
): Promise<Map<DocumentId, DocumentRecord>> {
  const records = new Map<DocumentId, DocumentRecord>();
  const versions = new Map<DocumentId, number>();
  if (actions.size === 0) return records;
  const ids = JSON.stringify([...actions.keys()].map((id) => ({ id })));
  const rows: (RecordRow & { id: string })[] = await tx`
    SELECT d.id, d.record FROM pi_documents d
    JOIN json_to_recordset(${ids}::text::json) AS q(id bigint) ON d.id = q.id
    WHERE d.session_id = ${sessionId}
  `;
  for (const row of rows) {
    records.set(int(row.id, 'id') as DocumentId, decode<DocumentRecord>(row));
  }
  const revisions: { document_id: string; version: number }[] = await tx`
    SELECT DISTINCT ON (r.document_id) r.document_id, r.version
    FROM pi_document_revisions r
    JOIN json_to_recordset(${ids}::text::json) AS q(id bigint)
      ON r.document_id = q.id
    WHERE r.session_id = ${sessionId}
    ORDER BY r.document_id, r.seq DESC
  `;
  for (const row of revisions) {
    versions.set(
      int(row.document_id, 'document_id') as DocumentId,
      row.version,
    );
  }

  const live = new Map<string, number>();
  for (const [id, action] of actions) {
    if (action.copy !== undefined && actions.has(action.copy.id)) {
      throw new StorageRejected(
        `Document copy ${id} source is changed in the copy batch`,
      );
    }
    const found = records.get(id);
    if (action.create === undefined && found === undefined) {
      throw new Error(`Unknown document: ${id}`);
    }
    if (action.create !== undefined && found !== undefined) {
      throw new Error(`Document ${id} already exists`);
    }
    if (found?.retiredAt !== undefined)
      throw new Error(`Document ${id} is retired`);
    if (action.content?.kind === 'delta') {
      const previous = versions.get(id);
      if (previous === undefined)
        throw new Error(`Document ${id} delta has no base`);
      if (previous !== action.content.version) {
        throw new Error(`Document ${id} version transition requires a base`);
      }
    }
    if (action.create === undefined && !action.retire) continue;
    const record = action.create ?? found!;
    const key = JSON.stringify(Object.values(addressColumns(record)));
    let count = live.get(key);
    if (count === undefined) {
      count =
        (await currentDocumentId(tx, sessionId, record)) === undefined ? 0 : 1;
    }
    if (action.retire && found !== undefined) count--;
    if (action.create !== undefined && !action.retire) count++;
    live.set(key, count);
  }
  for (const count of live.values()) {
    if (count > 1) {
      throw new Error('Document address already has a current incarnation');
    }
  }
  return records;
}

async function currentDocumentId(
  tx: SQL,
  sessionId: string,
  address: Parameters<typeof addressColumns>[0],
): Promise<string | undefined> {
  const column = addressColumns(address);
  const [row]: { id: string }[] = await tx`
    SELECT id FROM pi_documents
    WHERE session_id = ${sessionId} AND kind = ${column.kind}
      AND scope_kind = ${column.scopeKind} AND owner_id = ${column.ownerId}
      AND family = ${column.family} AND key_value = ${column.keyValue}
      AND retired_at IS NULL
    LIMIT 1
  `;
  return row?.id;
}

async function writeTables(
  tx: SQL,
  sessionId: string,
  writes: readonly TableWrite[],
  seq: number,
): Promise<void> {
  const conversations: object[] = [];
  const entries: object[] = [];
  const tasks = new Map<number, object>();
  const submissions = new Map<number, object>();
  for (const write of writes) {
    const record = json(write.value, `${write.type} ${write.value.id}`);
    switch (write.type) {
      case 'conversation':
        conversations.push({
          id: write.value.id,
          owner_conversation_id: write.value.owner?.conversationId ?? null,
          owner_task_id: write.value.owner?.taskId ?? null,
          record,
        });
        break;
      case 'entry':
        entries.push({
          id: write.value.id,
          conversation_id: write.value.conversationId,
          head: write.value.head ?? null,
          record,
        });
        break;
      case 'task':
        tasks.set(write.value.id, {
          id: write.value.id,
          conversation_id: write.value.conversationId,
          kind: indexed(write.value.kind),
          status: write.value.state.status,
          abort_requested: write.value.abortRequested,
          background: write.value.background,
          record,
        });
        break;
      case 'submission':
        submissions.set(write.value.id, {
          id: write.value.id,
          conversation_id: write.value.conversationId,
          request_id:
            write.value.requestId === undefined
              ? null
              : indexed(write.value.requestId),
          status: write.value.status,
          record,
        });
        break;
    }
  }
  if (conversations.length > 0) {
    await tx`
      INSERT INTO pi_conversations
        (session_id, id, owner_conversation_id, owner_task_id, record)
      SELECT ${sessionId}, id, owner_conversation_id, owner_task_id, record
      FROM json_to_recordset(${JSON.stringify(conversations)}::text::json)
        AS r(id bigint, owner_conversation_id bigint, owner_task_id bigint,
             record text)
    `;
  }
  if (entries.length > 0) {
    await tx`
      INSERT INTO pi_entries
        (session_id, id, conversation_id, head, commit_seq, record)
      SELECT ${sessionId}, id, conversation_id, head, ${seq}, record
      FROM json_to_recordset(${JSON.stringify(entries)}::text::json)
        AS r(id bigint, conversation_id bigint, head bigint, record text)
    `;
  }
  if (tasks.size > 0) {
    await tx`
      INSERT INTO pi_tasks (session_id, id, conversation_id, kind, status,
        abort_requested, background, record)
      SELECT ${sessionId}, id, conversation_id, kind, status,
        abort_requested, background, record
      FROM json_to_recordset(${JSON.stringify([...tasks.values()])}::text::json)
        AS r(id bigint, conversation_id bigint, kind text, status text,
             abort_requested boolean, background boolean, record text)
      ON CONFLICT (session_id, id) DO UPDATE SET
        conversation_id = excluded.conversation_id, kind = excluded.kind,
        status = excluded.status, abort_requested = excluded.abort_requested,
        background = excluded.background, record = excluded.record
    `;
  }
  if (submissions.size > 0) {
    await tx`
      INSERT INTO pi_submissions
        (session_id, id, conversation_id, request_id, status, record)
      SELECT ${sessionId}, id, conversation_id, request_id, status, record
      FROM json_to_recordset(${JSON.stringify([...submissions.values()])}::text::json)
        AS r(id bigint, conversation_id bigint, request_id text, status text,
             record text)
      ON CONFLICT (session_id, id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        request_id = excluded.request_id, status = excluded.status,
        record = excluded.record
    `;
  }
}

async function writeDocuments(
  tx: SQL,
  sessionId: string,
  actions: ReadonlyMap<DocumentId, DocumentAction>,
  existing: ReadonlyMap<DocumentId, DocumentRecord>,
  seq: number,
): Promise<void> {
  for (const [id, action] of actions) {
    let content = action.content;
    if (action.copy !== undefined)
      content = await copiedContent(tx, sessionId, id, action);
    let record: DocumentRecord;
    if (action.create !== undefined) {
      record = {
        ...action.create,
        createdAt: seq,
        ...(action.retire ? { retiredAt: seq } : {}),
      } as DocumentRecord;
      const address = addressColumns(record);
      await tx`
        INSERT INTO pi_documents (session_id, id, kind, family, key_value,
          scope_kind, owner_id, created_at, retired_at, record)
        VALUES (${sessionId}, ${id}, ${address.kind}, ${address.family},
          ${address.keyValue}, ${address.scopeKind}, ${address.ownerId},
          ${seq}, ${action.retire ? seq : null}, ${json(record, `document ${id}`)})
      `;
    } else {
      record = existing.get(id)!;
    }
    if (content !== undefined) {
      if (content.kind === 'base' && isCurrentOnly(record)) {
        await tx`
          DELETE FROM pi_document_revisions
          WHERE session_id = ${sessionId} AND document_id = ${id}
        `;
      }
      const encoded = content.kind === 'base' ? content.value : content.ops;
      await tx`
        INSERT INTO pi_document_revisions
          (session_id, document_id, seq, kind, version, content)
        VALUES (${sessionId}, ${id}, ${seq}, ${content.kind},
          ${content.version}, ${json(encoded, `document ${id}`)})
      `;
    }
    if (action.retire) {
      if (action.create === undefined) {
        record = { ...record, retiredAt: seq } as DocumentRecord;
        await tx`
          UPDATE pi_documents
          SET retired_at = ${seq}, record = ${json(record, `document ${id}`)}
          WHERE session_id = ${sessionId} AND id = ${id}
        `;
      }
      if (isCurrentOnly(record)) {
        await tx`
          DELETE FROM pi_document_revisions
          WHERE session_id = ${sessionId} AND document_id = ${id}
        `;
      }
    }
  }
}

/** A copy is the source's base at the chosen point, checked against the new record. */
async function copiedContent(
  tx: SQL,
  sessionId: string,
  id: DocumentId,
  action: DocumentAction,
): Promise<DocumentContent> {
  try {
    const source = action.copy!;
    const stored = await materializeDocument(
      tx,
      sessionId,
      source.id,
      source.at,
    );
    if (stored === undefined) {
      throw new Error(`Fork source document ${source.id} cannot be read`);
    }
    const create = action.create!;
    if (
      stored.record.scope.kind !== 'conversation' ||
      create.scope.kind !== 'conversation' ||
      stored.record.kind !== create.kind ||
      stored.record.key !== create.key ||
      stored.record.history !== create.history ||
      stored.record.fork !== create.fork
    ) {
      throw new Error(
        `Fork source document ${source.id} does not match the copied record`,
      );
    }
    return { kind: 'base', version: stored.version, value: stored.value };
  } catch (error) {
    if (error instanceof StorageRejected) throw error;
    throw new StorageRejected(`Document copy ${id} was rejected`, {
      cause: error,
    });
  }
}
