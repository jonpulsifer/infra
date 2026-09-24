/**
 * Cloud Logging entries, the records they reduce to, and the resume cursor.
 * The cursor is `{ at, insertId }`, not a page token: a page token expires and
 * names a place in one query, where these name a place in the log itself.
 */

export const TASK_INDEX_LABEL = 'run.googleapis.com/task_index';

export interface CloudLogPage {
  readonly entries?: readonly CloudLogEntry[];
}

export interface CloudLogEntry {
  readonly timestamp?: string;
  readonly receiveTimestamp?: string;
  readonly insertId?: string;
  readonly textPayload?: string;
  readonly jsonPayload?: unknown;
  readonly severity?: string;
  readonly resource?: { readonly labels?: Record<string, string> };
  /** On a job's entries, the execution and task that wrote them. */
  readonly labels?: Record<string, string>;
}

export interface CloudLogRecord {
  readonly at: string;
  readonly insertId: string;
  readonly line: string;
  readonly replica: string;
}

export function cloudLogRecord(entry: CloudLogEntry): CloudLogRecord | null {
  const at = entry.timestamp ?? entry.receiveTimestamp;
  if (!at || !entry.insertId) return null;
  const line =
    entry.textPayload ??
    (entry.jsonPayload === undefined
      ? null
      : JSON.stringify(entry.jsonPayload));
  if (line === null || line.trim() === '') return null;
  return {
    at,
    insertId: entry.insertId,
    line,
    // A revision for a service, a task for a run, even when there is only one.
    replica:
      entry.resource?.labels?.revision_name ??
      taskReplica(entry.labels?.[TASK_INDEX_LABEL]) ??
      'unknown',
  };
}

export function taskReplica(index: string | undefined): string | undefined {
  return index === undefined ? undefined : `task ${index}`;
}

export function cloudLogCursor(
  cursor: string | undefined,
): CloudLogRecord | null {
  if (cursor === undefined) return null;
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64').toString('utf8'),
    ) as {
      at?: unknown;
      insertId?: unknown;
    };
    return typeof value.at === 'string' && typeof value.insertId === 'string'
      ? { at: value.at, insertId: value.insertId, line: '', replica: '' }
      : null;
  } catch {
    return null;
  }
}

export function encodeCloudLogCursor(record: CloudLogRecord): string {
  return Buffer.from(
    JSON.stringify({ at: record.at, insertId: record.insertId }),
  ).toString('base64');
}
