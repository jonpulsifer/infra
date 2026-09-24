/**
 * The real handler over a private schema in real Postgres and a private sites
 * directory. Site databases and roles are cluster-wide, so they carry a
 * per-file prefix and are dropped when the file is done.
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

function schemaName(): string {
  return `kthx_test_${crypto.randomUUID().replaceAll('-', '')}`;
}

/** Starts with a letter: legal as a kthx name and a Postgres identifier. */
function prefixName(): string {
  return `t${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
}

let admin: SQL | null = null;

/** Never closed: it lives as long as the test process. */
function adminSession(): SQL {
  admin ??= new SQL(serverUrl(), { max: 1 });
  return admin;
}

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
  fetch(request: Request, server?: Bun.Server<unknown>): Promise<Response>;
  /** The same server on a real port, for tests that need a socket. */
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
      controlHost: null,
      // With no identity host, the identity header is read nowhere.
      identityHost: null,
      identityHeader: 'tailscale-user-login',
      bucket: null,
      sitesDir,
      databaseUrl: url.toString(),
      meKey: 'k'.repeat(32),
      mePreviousKey: null,
      pgKey: 'p'.repeat(32),
      adminLogins: [],
      pgPrefix: prefix,
      maxDbBytes: 256 * 1024 * 1024,
      maxCollections: 256,
      // Unresolvable, so a stray upstream call fails on DNS instead of waiting
      // out the 90 s first-byte deadline.
      aiUrl: 'http://upstream.invalid/v1',
      aiKey: 'stub',
      aiModel: 'test-model',
      aiModels: [],
      aiMaxTokens: 4096,
      aiBuildMaxTokens: 4096,
      aiBuildModel: 'test-model',
      // Off, so a refusal under test makes one upstream call, not two.
      aiBuildFallbackModel: null,
      trustedProxies: [],
      tailnetProxies: [],
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
      // `undefined` only answers an upgraded socket, which needs `listen()`.
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
        // Only the site databases this test's rows name.
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

  // The template and group role outlive each test, so a claim stays cheap.
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

/** A request as it arrives from the Gateway. */
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
