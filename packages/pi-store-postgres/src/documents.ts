import { apply } from '@earendil-works/chord/delta';
import type {
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentRecord,
  JsonObject,
  StoredDocument,
} from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { decode, indexed, type RecordRow } from './rows.ts';

export function scopeColumns(scope: DocumentRecord['scope']): {
  scopeKind: string;
  ownerId: number;
} {
  switch (scope.kind) {
    case 'session':
      return { scopeKind: 'session', ownerId: 0 };
    case 'conversation':
      return { scopeKind: 'conversation', ownerId: scope.conversationId };
    case 'task':
      return { scopeKind: 'task', ownerId: scope.taskId };
  }
}

interface AddressColumns {
  kind: string;
  scopeKind: string;
  ownerId: number;
  family: boolean;
  keyValue: string;
}

export function addressColumns(address: DocumentAddress): AddressColumns {
  return {
    kind: indexed(address.kind),
    ...scopeColumns(address.scope),
    family: address.key !== undefined,
    keyValue: indexed(address.key ?? ''),
  };
}

export function isAliveAt(record: DocumentRecord, at: DocumentPoint): boolean {
  if (at === 'current') return record.retiredAt === undefined;
  return (
    record.createdAt <= at &&
    (record.retiredAt === undefined || at < record.retiredAt)
  );
}

export function isCurrentOnly(record: DocumentRecord): boolean {
  return record.scope.kind !== 'conversation' || record.history === 'latest';
}

interface RevisionRow {
  seq: string;
  kind: string;
  version: number;
  content: string;
}

/**
 * Reads the record and its revisions in the caller's transaction or
 * statement: a commit between the two queries could replace the base.
 */
export async function materializeDocument(
  sql: SQL,
  sessionId: string,
  id: DocumentId,
  at: DocumentPoint,
): Promise<StoredDocument | undefined> {
  const [row]: RecordRow[] = await sql`
    SELECT record FROM pi_documents
    WHERE session_id = ${sessionId} AND id = ${id}
  `;
  if (row === undefined) return undefined;
  const record = decode<DocumentRecord>(row);
  if (at !== 'current' && isCurrentOnly(record)) {
    throw new Error(`Document ${id} does not retain historical content`);
  }
  if (!isAliveAt(record, at)) return undefined;
  const upper = at === 'current' ? Number.MAX_SAFE_INTEGER : at;
  const [base]: RevisionRow[] = await sql`
    SELECT seq, kind, version, content FROM pi_document_revisions
    WHERE session_id = ${sessionId} AND document_id = ${id}
      AND kind = 'base' AND seq <= ${upper}
    ORDER BY seq DESC LIMIT 1
  `;
  if (base === undefined) {
    throw new Error(`Document ${id} is missing a required base`);
  }
  let value = JSON.parse(base.content) as JsonObject;
  const tail: RevisionRow[] = await sql`
    SELECT seq, kind, version, content FROM pi_document_revisions
    WHERE session_id = ${sessionId} AND document_id = ${id}
      AND seq > ${base.seq} AND seq <= ${upper}
    ORDER BY seq
  `;
  for (const revision of tail) {
    if (revision.kind !== 'delta' || revision.version !== base.version) {
      throw new Error(
        `Document ${id} crosses a stored version boundary without a base`,
      );
    }
    value = apply(value, JSON.parse(revision.content));
  }
  return { record, version: base.version, value, deltasSinceBase: tail.length };
}
