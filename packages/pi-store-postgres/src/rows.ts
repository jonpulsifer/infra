/**
 * Row codecs. Bun's SQL returns bigint columns as strings, so every integer is
 * read through `int`, which refuses any value a JS number cannot hold.
 */
import {
  type Cursor,
  type Page,
  type ScanOrder,
  StorageRequestError,
} from '@earendil-works/pi-durable';

export interface RecordRow {
  record: string;
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

/**
 * Indexed strings are stored as their JSON text, so a lone surrogate or NUL
 * in a kind, key or request id is neither refused nor replaced by Postgres.
 */
export function indexed(value: string): string {
  return JSON.stringify(value);
}

export function decode<T>(row: RecordRow): T {
  return JSON.parse(row.record) as T;
}

export function cursorAfter(cursor: Cursor | undefined): number | undefined {
  const after = cursor?.after;
  if (after === undefined) return undefined;
  if (typeof after !== 'number' || !Number.isSafeInteger(after)) {
    throw new StorageRequestError('Invalid storage cursor');
  }
  return after;
}

export interface ScanStart {
  order: ScanOrder;
  after: number | undefined;
}

const isOrder = (value: unknown): value is ScanOrder =>
  value === 'ascending' || value === 'descending';

/**
 * A scan's order and position. A cursor continues in the order it was made
 * with, and a query that asks for the other order is refused. A cursor without
 * an order continues in the scan's default.
 */
export function scanStart(
  requested: ScanOrder | undefined,
  cursor: Cursor | undefined,
  fallback: ScanOrder,
): ScanStart {
  if (requested !== undefined && !isOrder(requested)) {
    throw new StorageRequestError(`Invalid scan order: ${String(requested)}`);
  }
  const after = cursorAfter(cursor);
  if (cursor === undefined) return { order: requested ?? fallback, after };
  const stored = cursor.order;
  if (stored !== undefined && !isOrder(stored)) {
    throw new StorageRequestError('Invalid storage cursor');
  }
  const order = stored ?? fallback;
  if (requested !== undefined && requested !== order) {
    throw new StorageRequestError(
      `The cursor continues a ${order} scan; the query asks for ${requested}`,
    );
  }
  return { order, after };
}

/** Turns a scan of up to `limit + 1` rows into a page and its continuation. */
export function page<T extends { id: number }>(
  values: readonly T[],
  limit: number,
  order?: ScanOrder,
): Page<T, Cursor> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  const after = items.at(-1)!.id;
  return { items, next: order === undefined ? { after } : { after, order } };
}
