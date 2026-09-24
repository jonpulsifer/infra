/**
 * A Postgres database and `LOGIN` role per site, so isolation holds at the
 * connection. The role's password is derived from `KTHX_PG_KEY` and never
 * stored, so re-running provisioning repairs a restore or a key rotation.
 */
import { createHmac } from 'node:crypto';
import { SQL } from 'bun';
import type { Config } from './env.ts';

/**
 * Bun puts the SQLSTATE on `errno`; `code` is `ERR_POSTGRES_SERVER_ERROR` for
 * every server error.
 */
export function sqlState(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'errno' in cause
    ? String((cause as { errno: unknown }).errno)
    : '';
}

const DUPLICATE_OBJECT = '42710';
const DUPLICATE_DATABASE = '42P04';
export const UNDEFINED_DATABASE = '3D000';
export const INVALID_PASSWORD = '28P01';
/** `statement_timeout` fired. */
export const QUERY_CANCELED = '57014';
export const UNIQUE_VIOLATION = '23505';

const IDENT = /^[a-z0-9][a-z0-9_-]*$/;
const DERIVED = /^[A-Za-z0-9_-]+$/;
const SITE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * `CREATE DATABASE` takes no parameters, so a name is checked again here and a
 * caller that passes an unchecked string crashes.
 */
function q(name: string): string {
  if (!IDENT.test(name) || name.length > 63) {
    throw new Error(`refusing to use ${JSON.stringify(name)} as an identifier`);
  }
  return `"${name}"`;
}

function literal(derived: string): string {
  if (!DERIVED.test(derived)) throw new Error('refusing to splice a password');
  return `'${derived}'`;
}

export function sitePassword(key: string, name: string): string {
  return createHmac('sha256', key).update(`pg:${name}`).digest('base64url');
}

/**
 * Drops the control URL's search parameters: the test harness sets a
 * `search_path` to a schema that exists only in the control database.
 */
function urlFor(
  base: string,
  database: string,
  as?: { name: string; password: string },
  options?: string,
): string {
  const url = new URL(base);
  url.search = '';
  url.pathname = `/${database}`;
  if (as !== undefined) {
    url.username = as.name;
    url.password = as.password;
  }
  if (options !== undefined) url.searchParams.set('options', options);
  return url.toString();
}

/**
 * 2 s outlasts any query this API builds. The idle-transaction timeout stops a
 * vanished client from holding one of the pool's two connections.
 */
const SITE_OPTIONS =
  '-c search_path=public -c statement_timeout=2000 -c idle_in_transaction_session_timeout=5000';

/** Open site pools; the least recently used closes first. */
export const MAX_POOLS = 64;
const SNAPSHOT_MS = 10_000;

export interface Snapshot {
  readonly bytes: number;
  readonly collections: Set<string>;
}

/** The site is being deleted, so its pool must not be reopened. */
export class SiteGone extends Error {
  override readonly name = 'SiteGone';
}

export class Pg {
  /** In least-recently-used order. */
  private readonly pools = new Map<string, SQL>();
  private readonly snapshots = new Map<string, Snapshot & { at: number }>();
  /** Names {@link drop} is working on. */
  private readonly leaving = new Set<string>();
  /** One repair per name at a time, so a burst of 503s is one round of DDL. */
  private readonly repairs = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly control: SQL,
  ) {}

  /** The database every site is cloned from. */
  get template(): string {
    return `template_${this.config.pgPrefix}`;
  }

  /** The NOLOGIN role that holds the table grants. */
  get group(): string {
    return `${this.config.pgPrefix}_site`;
  }

  /**
   * Closes its template connection before returning: a clone fails while any
   * session is on the source database.
   */
  async bootstrap(): Promise<void> {
    await this.tolerate(
      DUPLICATE_OBJECT,
      `create role ${q(this.group)} nologin`,
    );
    await this.tolerate(
      DUPLICATE_DATABASE,
      `create database ${q(this.template)} is_template true`,
    );
    const template = new SQL(
      urlFor(this.config.databaseUrl, this.template, undefined, SITE_OPTIONS),
      { max: 1 },
    );
    try {
      // Grants to the group role are copied with the template, so a claim needs
      // no `GRANT`: the site's role is a member of the group.
      await template.unsafe(`create table if not exists documents (
        collection text not null,
        id text not null,
        data jsonb not null,
        etag text not null,
        created_at timestamptz(3) not null default now(),
        updated_at timestamptz(3) not null default now(),
        primary key (collection, id)
      )`);
      await template.unsafe(`create index if not exists documents_data
        on documents using gin (data jsonb_path_ops)`);
      await template.unsafe(`create index if not exists documents_recent
        on documents (collection, created_at desc, id)`);
      // Small tables written by anyone: vacuum well before the default
      // thresholds.
      await template.unsafe(`alter table documents set (
        autovacuum_vacuum_scale_factor = 0.05,
        autovacuum_analyze_scale_factor = 0.05
      )`);
      await template.unsafe(
        `grant select, insert, update, delete on documents to ${q(this.group)}`,
      );
    } finally {
      await template.close();
    }
  }

  /**
   * Idempotent: existing objects are tolerated and the password is re-applied,
   * which also repairs a key rotation or a restore without role passwords.
   */
  async provision(name: string): Promise<void> {
    const password = sitePassword(this.config.pgKey, name);
    const existed = await this.tolerate(
      DUPLICATE_OBJECT,
      `create role ${q(name)} login password ${literal(password)}
       connection limit 4 in role ${q(this.group)}`,
    );
    if (existed) {
      await this.control.unsafe(
        `alter role ${q(name)} password ${literal(password)}`,
      );
    }
    // Inherit, so `DROP DATABASE … WITH (FORCE)` may end the site's sessions;
    // no `SET`, so this role never acts as the site.
    await this.control.unsafe(
      `grant ${q(name)} to current_user with inherit true, set false`,
    );
    await this.tolerate(
      DUPLICATE_DATABASE,
      `create database ${q(name)} template ${q(this.template)}`,
    );
    // Database ACLs are not copied from a template; this keeps other sites'
    // roles out.
    await this.control.unsafe(
      `revoke connect, temp on database ${q(name)} from public`,
    );
    await this.control.unsafe(
      `grant connect on database ${q(name)} to ${q(name)}`,
    );
    await this.control`
      update sites set provisioned_at = now() where name = ${name}
    `;
    // An open pool holds the old password. Close it: an abandoned Bun `SQL`
    // keeps its sockets.
    const stale = this.pools.get(name);
    this.pools.delete(name);
    this.snapshots.delete(name);
    await stale?.close({ timeout: 5 }).catch(() => {});
  }

  async inUse(name: string): Promise<boolean> {
    const [row] = (await this.control`
      select exists (select 1 from pg_database where datname = ${name})
          or exists (select 1 from pg_roles where rolname = ${name}) as taken
    `) as { taken: boolean }[];
    return row?.taken ?? false;
  }

  /**
   * Runs as the site's own role. A missing database or a refused password is
   * repaired once and retried.
   */
  async site<T>(name: string, run: (sql: SQL) => Promise<T>): Promise<T> {
    try {
      return await run(this.pool(name));
    } catch (cause) {
      const state = sqlState(cause);
      if (state !== UNDEFINED_DATABASE && state !== INVALID_PASSWORD)
        throw cause;
      await this.repair(name);
      return await run(this.pool(name));
    }
  }

  private pool(name: string): SQL {
    if (this.leaving.has(name)) throw new SiteGone(`${name} is being deleted`);
    const open = this.pools.get(name);
    if (open !== undefined) {
      // A Map iterates in insertion order, so re-inserting keeps the first key
      // the least recently used.
      this.pools.delete(name);
      this.pools.set(name, open);
      return open;
    }
    const sql = new SQL(
      urlFor(
        this.config.databaseUrl,
        name,
        { name, password: sitePassword(this.config.pgKey, name) },
        SITE_OPTIONS,
      ),
      { max: 2, idleTimeout: 60 },
    );
    this.pools.set(name, sql);
    while (this.pools.size > MAX_POOLS) {
      const [oldest] = this.pools.keys();
      if (oldest === undefined) break;
      const evicted = this.pools.get(oldest);
      this.pools.delete(oldest);
      void evicted?.close({ timeout: 5 });
    }
    return sql;
  }

  /**
   * Reads the row first: `leaving` covers only {@link drop} itself, and a
   * handler that read a live row before a delete must not re-create it.
   */
  async repair(name: string): Promise<void> {
    const [row] = (await this.control`
      select deleted_at from sites where name = ${name}
    `) as { deleted_at: Date | null }[];
    if (row === undefined || row.deleted_at !== null) {
      throw new SiteGone(`${name} is gone`);
    }
    const running = this.repairs.get(name);
    if (running !== undefined) return running;
    const attempt = this.provision(name).finally(() => {
      this.repairs.delete(name);
    });
    this.repairs.set(name, attempt);
    return attempt;
  }

  /** Re-provisions every live site and returns the names that failed. */
  async repairAll(): Promise<string[]> {
    const rows = (await this.control`
      select name from sites where deleted_at is null order by name
    `) as { name: string }[];
    const failed: string[] = [];
    for (const { name } of rows) {
      await this.provision(name).catch(() => failed.push(name));
    }
    return failed;
  }

  async drop(name: string): Promise<void> {
    this.leaving.add(name);
    try {
      const pool = this.pools.get(name);
      this.pools.delete(name);
      this.snapshots.delete(name);
      // Bun lets in-flight queries finish for up to 5 s; `FORCE` ends the rest.
      await pool?.close({ timeout: 5 });
      await this.control.unsafe(
        `drop database if exists ${q(name)} with (force)`,
      );
      await this.control.unsafe(`drop role if exists ${q(name)}`);
    } finally {
      this.leaving.delete(name);
    }
  }

  /** The meter a site's quota is read from. */
  async bytes(name: string): Promise<number> {
    try {
      const [row] = (await this.control`
        select pg_database_size(${name})::bigint as bytes
      `) as { bytes: string | number }[];
      return Number(row?.bytes ?? 0);
    } catch (cause) {
      // No database yet means nothing spent. Any other failure propagates: a
      // quota meter must not fail open.
      if (sqlState(cause) === UNDEFINED_DATABASE) return 0;
      throw cause;
    }
  }

  /**
   * Cached per site: a stale byte count only lets a write overshoot the quota
   * slightly, and {@link noteCollection} adds new collections meanwhile.
   */
  async snapshot(name: string): Promise<Snapshot> {
    const held = this.snapshots.get(name);
    if (held !== undefined && Date.now() - held.at < SNAPSHOT_MS) return held;
    const bytes = await this.bytes(name);
    const collections = await this.site(name, async (sql) => {
      const rows = (await sql`
        select distinct collection from documents
      `) as { collection: string }[];
      return new Set(rows.map((row) => row.collection));
    });
    const fresh = { at: Date.now(), bytes, collections };
    this.snapshots.set(name, fresh);
    return fresh;
  }

  noteCollection(name: string, collection: string): void {
    this.snapshots.get(name)?.collections.add(collection);
  }

  /**
   * Drops databases and roles no live site names, left by failed claims and
   * interrupted deletes.
   *
   * ponytail: `consider` confines a test's sweep to its own names; production
   * sweeps the whole cluster, which one kthx owns.
   */
  async sweep(
    consider: (name: string) => boolean = () => true,
  ): Promise<string[]> {
    const [me] = (await this.control`select current_user as name`) as {
      name: string;
    }[];
    const keep = new Set([
      new URL(this.config.databaseUrl).pathname.slice(1),
      this.template,
      this.group,
      me?.name ?? '',
      'postgres',
    ]);
    // Only what a claim could make: no underscore, at least three characters,
    // which keeps this off `streaming_replica` and the cluster's own names.
    const mine = (name: string) =>
      SITE_NAME.test(name) &&
      name.length >= 3 &&
      name.length <= 40 &&
      !keep.has(name) &&
      consider(name);

    const dropped: string[] = [];
    const databases = (await this.control`
      select datname as name from pg_database d
      where not datistemplate
        and not exists (
          select 1 from sites s where s.name = d.datname and s.deleted_at is null
        )
    `) as { name: string }[];
    for (const { name } of databases) {
      if (!mine(name)) continue;
      await this.control.unsafe(
        `drop database if exists ${q(name)} with (force)`,
      );
      dropped.push(name);
    }
    // Only members of the group role: a `backup` or `readonly` login passes the
    // name test and must survive.
    const roles = (await this.control`
      select r.rolname as name from pg_roles r
      join pg_auth_members m on m.member = r.oid
      join pg_roles g on g.oid = m.roleid and g.rolname = ${this.group}
      where not r.rolsuper
        and not exists (
          select 1 from sites s where s.name = r.rolname and s.deleted_at is null
        )
    `) as { name: string }[];
    for (const { name } of roles) {
      if (!mine(name)) continue;
      await this.control.unsafe(`drop role if exists ${q(name)}`);
      dropped.push(name);
    }
    return dropped;
  }

  async close(): Promise<void> {
    const open = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(open.map((sql) => sql.close({ timeout: 5 })));
  }

  /** True when the statement failed with `state`: the object already exists. */
  private async tolerate(state: string, statement: string): Promise<boolean> {
    try {
      await this.control.unsafe(statement);
      return false;
    } catch (cause) {
      if (sqlState(cause) === state) return true;
      throw cause;
    }
  }
}
