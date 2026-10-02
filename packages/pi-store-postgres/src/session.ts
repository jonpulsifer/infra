/**
 * Sessions keyed by a caller's id, such as a thread key: create one on first
 * open, reopen it after that. There is no fork and no listing.
 */
import type { Storage } from '@earendil-works/pi-durable';
import type { SQL } from 'bun';
import { retrying } from './retry.ts';
import { int } from './rows.ts';
import { postgresStorage } from './storage.ts';

export async function openStorage(sql: SQL, id: string): Promise<Storage> {
  await retrying(
    () => sql`
      INSERT INTO pi_sessions (id, created_at, next_id, next_seq)
      VALUES (${id}, ${Date.now()}, 2, 1)
      ON CONFLICT (id) DO NOTHING
    `,
  );
  const [row] = await retrying(
    () => sql`SELECT next_seq FROM pi_sessions WHERE id = ${id}`,
  );
  if (row === undefined) {
    throw new Error(`pi-store: session ${id} was deleted while it opened`);
  }
  return postgresStorage(sql, id, int(row.next_seq, 'next_seq'));
}

/** Deletes a session and everything in it; a missing session is fine. */
export async function deleteStorage(sql: SQL, id: string): Promise<void> {
  await retrying(() =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      await tx`DELETE FROM pi_sessions WHERE id = ${id}`;
    }),
  );
}

export async function storageExists(sql: SQL, id: string): Promise<boolean> {
  const [row] = await retrying(
    () => sql`
      SELECT EXISTS (SELECT 1 FROM pi_sessions WHERE id = ${id}) AS present
    `,
  );
  return row.present;
}
