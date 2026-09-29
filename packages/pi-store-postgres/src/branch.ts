/**
 * Branch scans as one recursive query, with the semantics of pi's in-memory
 * store (in-memory-storage-state.ts): walk parents from `start`, cut the walk
 * at the first stop in scan order (so oldest-first stops at the stop nearest
 * the root), then filter, then apply the cursor, then the limit.
 *
 * A parent always commits before its child, so seq order is branch order.
 */
import type { StorageBranchScan } from '@earendil-works/pi-agent-core';
import type { SQL } from 'bun';
import { type EntryRow, pageSize, type StructureRow } from './rows.ts';

export function scanBranchEntries(
  sql: SQL,
  sessionId: string,
  query: StorageBranchScan,
): Promise<EntryRow[]> {
  return scan(sql, sessionId, query, true);
}

export function scanBranchStructures(
  sql: SQL,
  sessionId: string,
  query: StorageBranchScan,
): Promise<StructureRow[]> {
  return scan(sql, sessionId, query, false);
}

async function scan<T>(
  sql: SQL,
  sessionId: string,
  query: StorageBranchScan,
  payload: boolean,
): Promise<T[]> {
  const rows: T[] = await branchQuery(sql, sessionId, query, payload);
  if (rows.length === 0 && !(await entryExists(sql, sessionId, query.start))) {
    throw new Error(`Unknown branch start: ${query.start}`);
  }
  return rows;
}

function branchQuery(
  sql: SQL,
  sessionId: string,
  query: StorageBranchScan,
  payload: boolean,
) {
  const newest = query.order !== 'oldestFirst';
  const stopId = query.stopAtId ?? null;
  const stopType = query.stopAtType ?? null;
  const limit = pageSize(query.limit);
  const direction = () => (newest ? sql`DESC` : sql`ASC`);
  return sql`
    WITH RECURSIVE branch AS (
      SELECT id, parent_id, seq, type, custom_type, timestamp
      FROM pi_entries
      WHERE session_id = ${sessionId} AND id = ${query.start}
      UNION ALL
      SELECT e.id, e.parent_id, e.seq, e.type, e.custom_type, e.timestamp
      FROM branch b
      JOIN pi_entries e ON e.session_id = ${sessionId} AND e.id = b.parent_id
      ${newest ? sql`WHERE (b.id = ${stopId} OR b.type = ${stopType}) IS NOT TRUE` : sql``}
    ),
    stopped AS (
      SELECT * FROM branch
      ${
        newest
          ? sql``
          : sql`WHERE seq <= coalesce(
              (SELECT min(seq) FROM branch
                WHERE id = ${stopId} OR type = ${stopType}),
              seq)`
      }
    ),
    picked AS (
      SELECT * FROM stopped
      WHERE true
      ${query.type === undefined ? sql`` : sql`AND type = ${query.type}`}
      ${query.customType === undefined ? sql`` : sql`AND custom_type = ${query.customType}`}
      ${
        query.cursor === undefined
          ? sql``
          : newest
            ? sql`AND seq < ${query.cursor.seq}`
            : sql`AND seq > ${query.cursor.seq}`
      }
      ORDER BY seq ${direction()}
      ${limit === undefined ? sql`` : sql`LIMIT ${limit}`}
    )
    SELECT p.*${payload ? sql`, e.payload` : sql``}
    FROM picked p
    ${
      payload
        ? sql`JOIN pi_entries e ON e.session_id = ${sessionId} AND e.id = p.id`
        : sql``
    }
    ORDER BY p.seq ${direction()}
  `;
}

async function entryExists(
  sql: SQL,
  sessionId: string,
  id: string,
): Promise<boolean> {
  const [row] = await sql`
    SELECT EXISTS (
      SELECT 1 FROM pi_entries WHERE session_id = ${sessionId} AND id = ${id}
    ) AS present
  `;
  return row.present;
}
