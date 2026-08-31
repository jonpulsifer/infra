/**
 * One private schema, one private sites directory, and the real handler over
 * both.
 *
 * The control database is real Postgres because everything interesting about a
 * release — the number it takes under a lock, the row that decides what serves
 * — is a claim about transactions that a fake store cannot falsify. It is
 * isolated by schema rather than by database so tests can run beside another
 * agent's on the same server: the schema name carries a unique prefix and is
 * dropped afterwards, and `search_path` travels in the connection handshake so
 * every session in the pool lands in it.
 *
 * A **site** database cannot be isolated that way — a site *is* a database and
 * a role, both cluster-wide names — so every name a test claims carries the
 * same prefix ({@link Harness.name}), the template and the group role are
 * named after it too, and everything with that prefix is dropped when the file
 * is done. Two agents running this suite at once therefore never see each
 * other's databases, roles, or template.
 *
 * The depot is the on-disk one for the same reason the database is real: the
 * rehydrate path is real code, and a second location scheme exercises it
 * better than a mock of the first.
 */
import { afterAll, afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { migrate } from '../../server/db.ts';
import { diskDepot } from '../../server/depot.ts';
import type { Config } from '../../server/env.ts';
import { handler, type Kthx } from '../../server/index.ts';
import { Pg } from '../../server/pg.ts';
import { websocket } from '../../server/realtime.ts';

export const ZONE = 'kthx.test';

function serverUrl(): string {
  const url = Bun.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set: these tests need a Postgres to build a schema in',
    );
  }
  return url;
}

/** A legal bare identifier that no other run can guess or collide with. */
function schemaName(): string {
  return `kthx_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

/**
 * The prefix this file's databases, roles and site names all start with.
 *
 * Alphanumeric and leading with a letter, so it is legal as a kthx name, as a
 * Postgres identifier, and as the head of `template_…` and `…_site`.
 */
function prefixName(): string {
  return `t${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

let admin: SQL | null = null;

/**
 * The one session that creates and drops schemas, databases and roles.
 *
 * Shared because it holds no isolated state, and never closed because it lives
 * exactly as long as the test process.
 */
function adminSession(): SQL {
  admin ??= new SQL(serverUrl(), { max: 1 });
  return admin;
}

/** Everything named for this prefix, gone. */
async function dropPrefixed(prefix: string): Promise<void> {
  const sql = adminSession();
  const databases = (await sql`
    select datname as name from pg_database
    where datname like ${`${prefix}%`} or datname = ${`template_${prefix}`}
  `) as { name: string }[];
  for (const { name } of databases) {
    await sql.unsafe(`alter database "${name}" is_template false`);
    await sql.unsafe(`drop database if exists "${name}" with (force)`);
  }
  const roles = (await sql`
    select rolname as name from pg_roles where rolname like ${`${prefix}%`}
  `) as { name: string }[];
  for (const { name } of roles) {
    await sql.unsafe(`drop role if exists "${name}"`);
  }
}

export interface Harness {
  readonly schema: string;
  readonly sql: SQL;
  readonly pg: Pg;
  readonly sitesDir: string;
  readonly config: Config;
  /** A site name only this file can claim. */
  name(label: string): string;
  /** The whole server, from `Host` to bytes. */
  fetch(request: Request, server?: Bun.Server<unknown>): Promise<Response>;
  /** The same server on a real port, for the tests that need a socket. */
  listen(): Bun.Server<unknown>;
}

export function withServer(overrides: Partial<Config> = {}): () => Harness {
  let current: (Harness & { close(): Promise<void> }) | null = null;
  const prefix = prefixName();

  beforeEach(async () => {
    const schema = schemaName();
    await adminSession().unsafe(`create schema "${schema}"`);

    const url = new URL(serverUrl());
    url.searchParams.set('options', `-c search_path=${schema}`);
    const sql = new SQL(url.toString(), { max: 2 });
    await migrate(sql);

    const sitesDir = await mkdtemp(join(tmpdir(), 'kthx-sites-'));
    const config: Config = {
      zone: ZONE,
      bucket: null,
      sitesDir,
      databaseUrl: url.toString(),
      meKey: 'k'.repeat(32),
      mePreviousKey: null,
      pgKey: 'p'.repeat(32),
      pgPrefix: prefix,
      maxDbBytes: 256 * 1024 * 1024,
      maxCollections: 256,
      trustedProxies: [],
      port: 0,
      ...overrides,
    };
    const pg = new Pg(config, sql);
    await pg.bootstrap();
    const fetch: Kthx = handler(
      config,
      sql,
      diskDepot(join(sitesDir, '.depot')),
      pg,
    );
    let server: Bun.Server<unknown> | null = null;

    current = {
      schema,
      sql,
      pg,
      sitesDir,
      config,
      name: (label) => `${prefix}-${label}`,
      // The handler answers `undefined` only for a socket it upgraded, which
      // needs a real server and therefore `listen()`.
      fetch: (request, on) =>
        fetch(request, on ?? server ?? undefined) as Promise<Response>,
      listen() {
        server ??= Bun.serve({
          port: 0,
          fetch,
          websocket,
        }) as Bun.Server<unknown>;
        return server;
      },
      async close() {
        server?.stop(true);
        await fetch.close();
        // Exactly the site databases this test made, named by its own rows.
        const rows = (await sql`select name from sites`) as { name: string }[];
        for (const row of rows) {
          await pg.drop(row.name).catch(() => {});
        }
        await sql.close();
        await rm(sitesDir, { recursive: true, force: true });
        await adminSession().unsafe(
          `drop schema if exists "${schema}" cascade`,
        );
      },
    };
  });

  afterEach(async () => {
    const finished = current;
    current = null;
    await finished?.close();
  });

  // The template and the group role outlive a single test — a `CREATE
  // DATABASE` per test is cheap only because the template is made once.
  afterAll(async () => {
    await dropPrefixed(prefix);
  });

  return () => {
    if (current === null) {
      throw new Error('withServer() was read outside a test');
    }
    return current;
  };
}

/** A request as it arrives from the Gateway: a `Host`, and an address. */
export function ask(
  path: string,
  init: RequestInit & {
    host?: string;
    token?: string;
    address?: string;
  } = {},
): Request {
  const { host = ZONE, token, address, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('host', host);
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);
  if (address !== undefined) headers.set('cf-connecting-ip', address);
  return new Request(`http://${host}${path}`, { ...rest, headers });
}
