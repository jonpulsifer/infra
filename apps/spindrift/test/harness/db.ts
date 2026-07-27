/**
 * Per-test database isolation (Task 7).
 *
 * § Testing: "Tests must be deterministic and offline — no cluster, no cloud
 * project, no network. **The only external process is Postgres**, because the
 * concurrency design is a claim about transactions and a fake store cannot
 * falsify it." Real Postgres is therefore not negotiable, which makes isolation
 * the harness's whole job: a suite that resets a shared schema at file scope
 * cannot be run beside anything, and the claims §6 makes about locking reads and
 * serialized deploys are exactly the claims two tests racing each other would
 * corrupt.
 *
 * The lever is a **Postgres schema per test**, created, migrated, and dropped
 * around each one, reached over a connection whose `search_path` names only that
 * schema. Nothing is qualified in application code — `src/db/schema.ts` declares
 * bare `pgTable`s — so the same Drizzle queries land in whichever schema the
 * session points at, and a row written by one test is not on any path the next
 * one searches.
 *
 * **What drizzle-kit's DDL forced.** The generated migration schema-qualifies
 * every `CREATE TYPE` and every foreign-key `REFERENCES` to `"public"`, e.g.
 * `CREATE TYPE "public"."app_source_kind" AS ENUM(...)`. A qualified name ignores
 * `search_path` entirely, so replaying the file as written would put all sixteen
 * enums in `public` — colliding on the second test — while the tables landed in
 * the isolated schema. Hence {@link migrationStatements}: the committed SQL is
 * read and its `"public".` qualifier — and only that qualifier, never the bare
 * word, which also appears as an `exposure_state` value and in the
 * `public_exposure` column — is rewritten to the test schema. That is a
 * mechanical rewrite of one token, so what runs is still the committed DDL.
 *
 * This is also why `src/db/migrate.ts` is not used here: `drizzle-orm`'s migrator
 * reads a folder and applies it verbatim, with no seam to rewrite through.
 */

import { afterEach, beforeEach } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SQL } from 'bun';
import {
  createClient,
  createDb,
  type Database,
  databaseUrl,
} from '../../src/db/client.ts';

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations');

/** drizzle-kit writes one statement per breakpoint, not per semicolon. */
const BREAKPOINT = '--> statement-breakpoint';

/**
 * The qualifier drizzle-kit bakes into `CREATE TYPE` and `REFERENCES`. Matched
 * with its quotes and trailing dot so the bare word `public` — a legitimate
 * `exposure_state` value and part of the `public_exposure` column name — is
 * untouched.
 */
const QUALIFIER = '"public".';

/** The committed migrations, in filename order, rewritten to target `schema`. */
async function migrationStatements(schema: string): Promise<string[]> {
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const statements: string[] = [];
  for (const file of files) {
    const sql = await Bun.file(join(MIGRATIONS, file)).text();
    for (const statement of sql.split(BREAKPOINT)) {
      const trimmed = statement.replaceAll(QUALIFIER, `"${schema}".`).trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
  }
  return statements;
}

/**
 * A schema name that is a legal bare identifier and cannot collide with another
 * test's — the isolation claim rests on the name being unguessable, not on a
 * counter that resets when a second process starts.
 */
function schemaName(): string {
  return `spindrift_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * A connection string pointing every session in the pool at one schema.
 *
 * The `options` startup parameter travels in the connection handshake, so it
 * applies to every connection the pool opens — a bare `SET search_path` would
 * only bind whichever connection happened to run it. `public` is deliberately
 * *not* on the path: leaving it there would let a query for a table this schema
 * is missing silently find one next door, which is the failure the isolation
 * exists to make impossible.
 */
function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/** One test's private, migrated schema. */
export interface IsolatedDatabase {
  /** The Postgres schema every session below is pinned to. */
  readonly schema: string;
  /** Drizzle over the primary connection — what a command context takes. */
  readonly db: Database;
  /** The primary connection, for catalog queries and raw SQL. */
  readonly client: SQL;
  /**
   * A second, independent session into the same schema. §6's locking read can
   * only be proven by two real sessions contending, so the harness hands them
   * out rather than leaving a test to rebuild the connection string.
   */
  connect(): SQL;
  /** Close every session handed out and drop the schema. */
  close(): Promise<void>;
}

/**
 * Create, migrate, and hand back one private schema.
 *
 * Callers that want it around every test should use {@link withIsolatedDatabase};
 * this is the form for a test that wants two of them at once, which is what the
 * isolation proof itself needs.
 */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const schema = schemaName();

  const admin = createClient();
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);
  await admin.close();

  const url = schemaUrl(schema);
  const opened: SQL[] = [];
  const connect = (): SQL => {
    const client = createClient({ DATABASE_URL: url });
    opened.push(client);
    return client;
  };

  const client = connect();
  for (const statement of await migrationStatements(schema)) {
    await client.unsafe(statement);
  }

  return {
    schema,
    client,
    db: createDb(client),
    connect,
    async close() {
      for (const open of opened) await open.close();
      const dropper = createClient();
      await dropper.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await dropper.close();
    },
  };
}

/**
 * A fresh migrated schema before every test in the enclosing scope, dropped
 * after it.
 *
 * Returns an accessor rather than a value because the value does not exist yet
 * when the file is read: `const database = withIsolatedDatabase()` at the top of a
 * file, `database().db` inside a test.
 */
export function withIsolatedDatabase(): () => IsolatedDatabase {
  let current: IsolatedDatabase | null = null;

  beforeEach(async () => {
    current = await createIsolatedDatabase();
  });

  afterEach(async () => {
    const finished = current;
    current = null;
    await finished?.close();
  });

  return () => {
    if (!current) {
      throw new Error(
        'withIsolatedDatabase() was read outside a test — call the accessor ' +
          'inside a test body, not at file scope',
      );
    }
    return current;
  };
}
