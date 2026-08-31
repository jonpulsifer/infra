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
 * The depot is the on-disk one for the same reason: the rehydrate path is real
 * code, and a second location scheme exercises it better than a mock of the
 * first.
 */
import { afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQL } from 'bun';
import { migrate } from '../../server/db.ts';
import { diskDepot } from '../../server/depot.ts';
import type { Config } from '../../server/env.ts';
import { handler } from '../../server/index.ts';

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

let admin: SQL | null = null;

/**
 * The one session that creates and drops schemas.
 *
 * Shared because it holds no isolated state, and never closed because it lives
 * exactly as long as the test process.
 */
function adminSession(): SQL {
  admin ??= new SQL(serverUrl(), { max: 1 });
  return admin;
}

export interface Harness {
  readonly schema: string;
  readonly sql: SQL;
  readonly sitesDir: string;
  readonly config: Config;
  /** The whole server, from `Host` to bytes. */
  fetch(request: Request, server?: Bun.Server<unknown>): Promise<Response>;
}

export function withServer(): () => Harness {
  let current: (Harness & { close(): Promise<void> }) | null = null;

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
      trustedProxies: [],
      port: 0,
    };
    const fetch = handler(config, sql, diskDepot(join(sitesDir, '.depot')));

    current = {
      schema,
      sql,
      sitesDir,
      config,
      fetch: (request, server) => fetch(request, server),
      async close() {
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
