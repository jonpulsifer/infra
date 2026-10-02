/**
 * Row codecs. Bun's SQL returns bigint columns as strings, so every integer is
 * read through `int`, which refuses any value a JS number cannot hold.
 */
import type { Cursor, Page } from '@earendil-works/pi-durable';

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
    throw new TypeError('Invalid storage cursor');
  }
  return after;
}

/** Turns a scan of up to `limit + 1` rows into a page and its continuation. */
export function page<T extends { id: number }>(
  values: readonly T[],
  limit: number,
): Page<T, Cursor> {
  const items = values.slice(0, limit);
  if (values.length <= limit) return { items };
  return { items, next: { after: items.at(-1)!.id } };
}
