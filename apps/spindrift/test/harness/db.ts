/**
 * A Postgres schema per test, migrated from the committed SQL and reached over
 * connections whose `search_path` names only that schema.
 */

import { afterEach, beforeEach } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SQL } from 'bun';
import {
  createClient,
  createDb,
  type Database,
  databaseUrl,
} from '../../src/db/client.ts';
import { vessels } from '../../src/db/schema.ts';
import {
  VESSEL_KINDS,
  type VesselKind,
  type VesselLocation,
} from '../../src/domain/vessel.ts';

const MIGRATIONS = join(import.meta.dir, '../../src/db/migrations');

/** drizzle-kit's statement separator. */
const BREAKPOINT = '--> statement-breakpoint';

/**
 * drizzle-kit qualifies `CREATE TYPE` and `REFERENCES` with this, bypassing
 * `search_path`. The quotes and dot spare the bare word `public` elsewhere.
 */
const QUALIFIER = '"public".';

/**
 * Read once per process and sent as one simple query, which Postgres runs in one
 * implicit transaction. A round trip per statement times out the hook under load.
 */
let committedDdl: string | null = null;

async function migrationDdl(): Promise<string> {
  if (committedDdl !== null) return committedDdl;
  const files = (await readdir(MIGRATIONS))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const statements: string[] = [];
  for (const file of files) {
    const sql = await Bun.file(join(MIGRATIONS, file)).text();
    for (const statement of sql.split(BREAKPOINT)) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) statements.push(trimmed);
    }
  }
  committedDdl = statements.join(';\n');
  return committedDdl;
}

async function migrationScript(schema: string): Promise<string> {
  return (await migrationDdl()).replaceAll(QUALIFIER, `"${schema}".`);
}

/**
 * One pool for the process creates and drops schemas: a pool per test churns
 * connections until Postgres answers `too many clients`. Never closed.
 */
let admin: SQL | null = null;

function adminSession(): SQL {
  admin ??= createClient();
  return admin;
}

/** Random, so test processes running side by side cannot collide. */
function schemaName(): string {
  return `spindrift_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * `options` rides the startup handshake, so it binds every pooled connection.
 * `public` stays off the path, so a missing table fails instead of resolving.
 */
function schemaUrl(schema: string): string {
  const url = new URL(databaseUrl());
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

export interface IsolatedDatabase {
  readonly schema: string;
  readonly db: Database;
  readonly client: SQL;
  /** Another session into the same schema, for tests of contending sessions. */
  connect(): SQL;
  /** Closes every session handed out and drops the schema. */
  close(): Promise<void>;
}

/**
 * One seeded vessel per kind, since `targets.vessel_id` is NOT NULL. Set by
 * {@link createIsolatedDatabase}; `targetValues()` reads it synchronously.
 */
let defaultVessels: Readonly<Record<VesselKind, string>> | null = null;

export function defaultVesselId(kind: VesselKind): string {
  if (defaultVessels === null) {
    throw new Error(
      'no isolated database is open — defaultVesselId() was read outside a test',
    );
  }
  return defaultVessels[kind];
}

export function defaultVesselName(kind: VesselKind): string {
  return `fixture-${kind}`;
}

/** A switch, so the compiler flags a new vessel kind with no location. */
function fixtureLocation(kind: VesselKind): VesselLocation {
  switch (kind) {
    case 'cluster':
      return { kind, apiServer: 'https://cluster.example.test' };
    case 'gcp-project':
      return { kind, project: 'example-vessel' };
    case 'vercel-team':
      return { kind, team: 'example-team' };
    case 'cloudflare-account':
      return { kind, account: 'example-account' };
  }
}

/** For a test that needs two schemas at once. */
export async function createIsolatedDatabase(): Promise<IsolatedDatabase> {
  const schema = schemaName();

  await adminSession().unsafe(`CREATE SCHEMA "${schema}"`);

  const url = schemaUrl(schema);
  const opened: SQL[] = [];
  const connect = (): SQL => {
    // One connection each: idle pool members exhaust `max_connections` when test
    // files run in parallel. A concurrent session is another `connect()`.
    const client = new SQL(url, { max: 1 });
    opened.push(client);
    return client;
  };

  const client = connect();
  await client.unsafe(await migrationScript(schema));

  const db = createDb(client);
  const seeded = await db
    .insert(vessels)
    .values(
      VESSEL_KINDS.map((kind) => ({
        name: defaultVesselName(kind),
        kind,
        location: fixtureLocation(kind),
      })),
    )
    .returning({ id: vessels.id, kind: vessels.kind });
  defaultVessels = Object.fromEntries(
    seeded.map((row) => [row.kind, row.id]),
  ) as Record<VesselKind, string>;

  return {
    schema,
    client,
    db,
    connect,
    async close() {
      for (const open of opened) await open.close();
      await adminSession().unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    },
  };
}

/**
 * A fresh schema around every test in the enclosing scope. Returns an accessor,
 * since the database exists only inside a test.
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
