/**
 * The control database, and the numbered SQL that builds it.
 *
 * Bun's `SQL` rather than an ORM. Three reasons, in order of weight: the claim
 * path in ticket 03 is `CREATE DATABASE` / `CREATE ROLE`, which no ORM models
 * and which cannot run inside a transaction; drizzle-kit's `generate` is broken
 * in this repo, so the migrations are hand-written either way; and the schema
 * here is two tables that a tagged template says more plainly than a query
 * builder would.
 *
 * Migrations are files, applied in name order, each recorded once. They run at
 * boot rather than as a separate Job because there is one replica by
 * construction and the schema is two tables — a migration Job would be a second
 * deployment artifact to keep in step with the image for no ordering it buys.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SQL } from 'bun';

const MIGRATIONS = join(import.meta.dir, 'migrations');

/** One site row, as every handler reads it. */
export interface SiteRow {
  readonly name: string;
  readonly token_hash: string;
  readonly serving: number | null;
  readonly held: boolean;
  readonly deleted_at: Date | null;
}

/** One release row. `size` arrives as a string: `bigint` is wider than a JS number. */
export interface ReleaseRow {
  readonly n: number;
  readonly digest: string;
  readonly size: string | number;
  readonly location: string;
  readonly at: Date;
}

export function createClient(url: string): SQL {
  return new SQL(url);
}

/**
 * Apply every migration this build carries that the database has not recorded.
 *
 * Each file runs inside its own transaction with its bookkeeping row, so a
 * half-applied file is not a state this can be left in. Unqualified DDL, so the
 * session's `search_path` decides where it lands — which is what lets the test
 * harness give every test its own schema without rewriting the committed SQL.
 */
export async function migrate(sql: SQL): Promise<string[]> {
  await sql.unsafe(`create table if not exists schema_migrations (
    name text primary key,
    at timestamptz(3) not null default now()
  )`);
  const applied = new Set(
    (
      (await sql.unsafe('select name from schema_migrations')) as {
        name: string;
      }[]
    ).map((row) => row.name),
  );
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const ddl = await Bun.file(join(MIGRATIONS, file)).text();
    await sql.begin(async (tx: SQL) => {
      await tx.unsafe(ddl);
      await tx`insert into schema_migrations (name) values (${file})`;
    });
    ran.push(file);
  }
  return ran;
}
