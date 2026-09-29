/**
 * Row codecs. Bun's SQL returns bigint columns as strings, so every integer is
 * read through `int`, which refuses any value a JS number cannot hold.
 */
import type {
  Entry,
  EntryStructure,
  UsageRow,
} from '@earendil-works/pi-agent-core';

export interface StructureRow {
  id: string;
  parent_id: string | null;
  seq: string | number;
  type: Entry['type'];
  custom_type: string | null;
  timestamp: string | number;
}

export interface EntryRow extends StructureRow {
  payload: string;
}

export interface UsageLedgerRow {
  id: string;
  seq: string | number;
  entry_id: string | null;
  adjustment: boolean;
  usage: string;
  details: string | null;
}

export function int(value: unknown, column: string): number {
  const number =
    typeof value === 'number' ||
    typeof value === 'string' ||
    typeof value === 'bigint'
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new Error(`pi-store: ${column} is not a safe integer: ${value}`);
  }
  return number;
}

export function json(value: unknown, what: string): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError(`pi-store: ${what} is not JSON-serializable`);
  }
  return text;
}

/** The entry minus the fields that have columns of their own. */
export function entryPayload(entry: Entry): string {
  const {
    id: _id,
    parentId: _parentId,
    seq: _seq,
    timestamp: _timestamp,
    type: _type,
    customType: _customType,
    ...payload
  } = entry;
  return json(payload, `entry ${entry.id}`);
}

export function decodeStructure(row: StructureRow): EntryStructure {
  return {
    id: row.id,
    parentId: row.parent_id,
    seq: int(row.seq, 'seq'),
    timestamp: int(row.timestamp, 'timestamp'),
    type: row.type,
    ...(row.custom_type === null ? {} : { customType: row.custom_type }),
  };
}

export function decodeEntry(row: EntryRow): Entry {
  return { ...JSON.parse(row.payload), ...decodeStructure(row) } as Entry;
}

export function decodeUsage(row: UsageLedgerRow): UsageRow {
  return {
    id: row.id,
    seq: int(row.seq, 'seq'),
    usage: JSON.parse(row.usage),
    ...(row.entry_id === null ? {} : { entryId: row.entry_id }),
    adjustment: row.adjustment,
    ...(row.details === null ? {} : { details: JSON.parse(row.details) }),
  };
}

/**
 * A page size as `Array.prototype.slice` reads pi's in-memory limits:
 * undefined or infinite means all, anything else truncates and floors at 0.
 */
export function pageSize(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  const size = Math.trunc(Math.max(0, limit));
  if (Number.isNaN(size)) return 0;
  return size > Number.MAX_SAFE_INTEGER ? undefined : size;
}
