/**
 * Sessions keyed by a caller's id, such as a thread key: create one on first
 * open, reopen it after that. There is no fork and no listing; pi's
 * SessionRepo is more than a host keyed by its own ids needs.
 */
import {
  type SessionMetadata,
  StorageBackedSession,
} from '@earendil-works/pi-agent-core';
import type { SQL } from 'bun';
import { retrying } from './retry.ts';
import { int, json } from './rows.ts';
import { postgresStorage } from './storage.ts';
import { emptyUsage } from './usage.ts';

export const POSTGRES_STORAGE_VERSION = 1;

/** The caller owns the pool: nothing here closes it. */
export interface PostgresStoreOptions {
  sql: SQL;
}

export interface PostgresSessionMetadata extends SessionMetadata {
  /** What the caller passed when the session was created. */
  metadata?: Record<string, unknown>;
}

export interface OpenSessionOptions {
  id: string;
  /** Stored when this call creates the session; ignored when it exists. */
  metadata?: Record<string, unknown>;
}

interface SessionRow {
  id: string;
  created_at: string;
  parent_session_id: string | null;
  storage_version: number;
  metadata: string | null;
}

export async function openSession(
  sql: SQL,
  options: OpenSessionOptions,
): Promise<StorageBackedSession<PostgresSessionMetadata>> {
  const { id } = options;
  const metadata =
    options.metadata === undefined
      ? null
      : json(options.metadata, 'session metadata');
  await retrying(
    () => sql`
      INSERT INTO pi_sessions (id, created_at, storage_version, metadata,
        message_count, usage_payload, next_seq)
      VALUES (${id}, ${Date.now()}, ${POSTGRES_STORAGE_VERSION}, ${metadata},
        0, ${json(emptyUsage(), 'session usage')}, 1)
      ON CONFLICT (id) DO NOTHING
    `,
  );
  const [row]: SessionRow[] = await retrying(
    () => sql`
      SELECT id, created_at, parent_session_id, storage_version, metadata
      FROM pi_sessions WHERE id = ${id}
    `,
  );
  if (row === undefined) {
    throw new Error(`pi-store: session ${id} was deleted while it opened`);
  }
  return new StorageBackedSession(metadataOf(row), postgresStorage(sql, id));
}

/** Deletes a session and everything in it; a missing session is fine. */
export async function deleteSession(sql: SQL, id: string): Promise<void> {
  await retrying(() =>
    sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
      await tx`DELETE FROM pi_sessions WHERE id = ${id}`;
    }),
  );
}

export async function sessionExists(sql: SQL, id: string): Promise<boolean> {
  const [row] = await retrying(
    () => sql`
      SELECT EXISTS (SELECT 1 FROM pi_sessions WHERE id = ${id}) AS present
    `,
  );
  return row.present;
}

function metadataOf(row: SessionRow): PostgresSessionMetadata {
  if (row.storage_version !== POSTGRES_STORAGE_VERSION) {
    throw new Error(
      `pi-store: session ${row.id} has storage version ${row.storage_version}, not ${POSTGRES_STORAGE_VERSION}`,
    );
  }
  return {
    id: row.id,
    createdAt: int(row.created_at, 'created_at'),
    storageVersion: row.storage_version,
    ...(row.parent_session_id === null
      ? {}
      : { parentSessionId: row.parent_session_id }),
    ...(row.metadata === null ? {} : { metadata: JSON.parse(row.metadata) }),
  };
}
