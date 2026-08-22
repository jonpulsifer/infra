/**
 * Reading Cloud Logging: the entry shapes, the record they reduce to, and the
 * cursor that resumes a read.
 *
 * Its own file because two callers now share it. The deploy adapter tails a
 * Component's Service or a run's Job through it, and `functions/` tails a
 * Cloud Run function through the same API — same entries, same defensive
 * reading, same "an entry with no timestamp or no insert id is not a line".
 *
 * The cursor is base64 over `{ at, insertId }` rather than the API's page
 * token: a page token expires and names a position in one query, where a
 * timestamp and an insert id name a position in the log itself, which is what
 * a caller resuming an hour later actually has.
 */

/** Where a job's entries carry which task wrote them. */
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
  /** Where a job's entries carry which execution and task wrote them. */
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
    // What wrote the line. A service's replica is a revision; a run's is one of
    // its tasks, and a run with `taskCount: 1` still names the task rather than
    // leaving the column reading `unknown` for every line it ever writes.
    replica:
      entry.resource?.labels?.revision_name ??
      taskReplica(entry.labels?.[TASK_INDEX_LABEL]) ??
      'unknown',
  };
}

/** The `task N` a task index reads as, or nothing when there is no index. */
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
