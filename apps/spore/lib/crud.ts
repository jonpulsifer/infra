import { eq } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import { revalidatePath } from 'next/cache';
import { db } from './db';

export interface CrudActionsConfig<TId extends string | number> {
  /** The Drizzle table this factory operates on. */
  table: SQLiteTable;
  /** The column used to identify a single row (primary key). */
  idColumn: SQLiteColumn;
  /** Paths to revalidate after a write. Receives the affected id, when known. */
  paths: (id?: TId) => string[];
  /** Stamp createdAt/updatedAt on writes. Defaults to true. */
  timestamps?: boolean;
}

/**
 * Build create/update/remove server actions for a simple entity table,
 * collapsing the "write + timestamp + revalidatePath" shape that would
 * otherwise be copy-pasted per entity (as it was for hosts, profiles, and
 * scripts in lib/actions.ts).
 *
 * Entities with extra business rules beyond plain CRUD (e.g. profiles'
 * single-default-profile invariant, or settings' upsert-only semantics)
 * still write their own create/update, but can reuse `revalidate` here to
 * keep revalidation paths declared in one place.
 */
export function makeCrudActions<
  TInsert extends Record<string, unknown>,
  TUpdate extends Record<string, unknown>,
  TId extends string | number = number,
>(config: CrudActionsConfig<TId>) {
  const { table, idColumn, paths, timestamps = true } = config;

  function revalidate(id?: TId) {
    for (const path of paths(id)) {
      revalidatePath(path);
    }
  }

  async function create(data: TInsert) {
    const now = new Date().toISOString();
    const values = timestamps
      ? { ...data, createdAt: now, updatedAt: now }
      : data;

    // Table/values are necessarily loosely typed here since this factory is
    // shared across entities with different schemas.
    const result = await db
      .insert(table)
      .values(values as any)
      .returning();

    revalidate();
    return result[0];
  }

  async function update(id: TId, data: TUpdate) {
    const now = new Date().toISOString();
    const values = timestamps ? { ...data, updatedAt: now } : data;

    await db
      .update(table)
      .set(values as any)
      .where(eq(idColumn, id));

    revalidate(id);
  }

  async function remove(id: TId) {
    await db.delete(table).where(eq(idColumn, id));
    revalidate(id);
  }

  return { create, update, remove, revalidate };
}
