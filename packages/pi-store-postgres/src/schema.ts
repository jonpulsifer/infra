/**
 * The Postgres schema for pi sessions, ported from pi's SQLite backend
 * (001_initial.sql). JSON is kept as text: jsonb refuses \u0000 and reorders
 * keys. Keys use the "C" collation so they sort by code point, as pi's
 * in-memory store does.
 */
import type { SQL } from 'bun';

interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE pi_sessions (
        id text COLLATE "C" PRIMARY KEY,
        created_at bigint NOT NULL,
        parent_session_id text COLLATE "C",
        storage_version integer NOT NULL,
        metadata text,
        message_count bigint NOT NULL,
        usage_payload text NOT NULL,
        next_seq bigint NOT NULL
      );

      CREATE TABLE pi_entries (
        session_id text COLLATE "C" NOT NULL
          REFERENCES pi_sessions (id) ON DELETE CASCADE,
        id text COLLATE "C" NOT NULL,
        parent_id text COLLATE "C",
        seq bigint NOT NULL,
        type text COLLATE "C" NOT NULL,
        custom_type text COLLATE "C",
        timestamp bigint NOT NULL,
        payload text NOT NULL,
        PRIMARY KEY (session_id, id),
        FOREIGN KEY (session_id, parent_id) REFERENCES pi_entries (session_id, id)
      );
      CREATE UNIQUE INDEX pi_entries_seq ON pi_entries (session_id, seq);
      CREATE INDEX pi_entries_parent ON pi_entries (session_id, parent_id);

      CREATE TABLE pi_scalar_values (
        session_id text COLLATE "C" NOT NULL
          REFERENCES pi_sessions (id) ON DELETE CASCADE,
        namespace text COLLATE "C" NOT NULL,
        key text COLLATE "C" NOT NULL,
        seq bigint NOT NULL,
        value text NOT NULL,
        PRIMARY KEY (session_id, namespace, key)
      );

      CREATE TABLE pi_list_values (
        session_id text COLLATE "C" NOT NULL
          REFERENCES pi_sessions (id) ON DELETE CASCADE,
        namespace text COLLATE "C" NOT NULL,
        key text COLLATE "C" NOT NULL,
        seq bigint NOT NULL,
        value text NOT NULL,
        PRIMARY KEY (session_id, namespace, key, seq)
      );

      CREATE TABLE pi_usage_ledger (
        session_id text COLLATE "C" NOT NULL
          REFERENCES pi_sessions (id) ON DELETE CASCADE,
        id text COLLATE "C" NOT NULL,
        seq bigint NOT NULL,
        entry_id text COLLATE "C",
        adjustment boolean NOT NULL,
        usage text NOT NULL,
        details text,
        PRIMARY KEY (session_id, id)
      );
      CREATE UNIQUE INDEX pi_usage_ledger_seq ON pi_usage_ledger (session_id, seq);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Applies every migration this database lacks, in one transaction under an
 * advisory lock, so each runs once however many callers race.
 */
export async function migrate(sql: SQL): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('pi_store_migrations'))`;
    await tx`
      CREATE TABLE IF NOT EXISTS pi_store_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    const rows: { version: number }[] =
      await tx`SELECT version FROM pi_store_migrations`;
    const applied = new Set(rows.map((row) => row.version));
    const newest = Math.max(0, ...applied);
    if (newest > SCHEMA_VERSION) {
      throw new Error(
        `pi-store schema version ${newest} is newer than this code knows (${SCHEMA_VERSION})`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO pi_store_migrations (version, name)
        VALUES (${migration.version}, ${migration.name})
      `;
    }
  });
}
