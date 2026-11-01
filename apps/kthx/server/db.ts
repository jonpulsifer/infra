/**
 * The control database and its migrations. Migrations run at boot in name
 * order, each recorded once; the server always runs one replica.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SQL } from 'bun';

const MIGRATIONS = join(import.meta.dir, 'migrations');

export function createClient(url: string): SQL {
  return new SQL(url);
}

/**
 * Each file runs in one transaction with its bookkeeping row. The DDL is
 * unqualified, so `search_path` picks the schema; tests use one per test.
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
