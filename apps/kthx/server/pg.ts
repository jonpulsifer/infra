/**
 * A Postgres database per site: how one comes into being, how it is reached,
 * and how it goes away.
 *
 * A database rather than a schema or a row-level policy because the boundary
 * has to hold against a connection, not against a query this process remembers
 * to write correctly. Every site gets a `LOGIN` role of its own and a database
 * only that role may `CONNECT` to, so the worst a bug in the query builder can
 * do is corrupt one site's documents. `CREATE DATABASE`/`CREATE ROLE` cannot
 * run inside a transaction, so provisioning is a sequence of idempotent
 * statements rather than an atomic step: the site row is inserted first and
 * holds the name while the rest catches up.
 *
 * The password is derived, never stored: `HMAC(KTHX_PG_KEY, "pg:" + name)`.
 * A restore of the cluster, or a rotation of that key, therefore needs no
 * secret store to be in step — the same statements that provision a site
 * repair one, and running them again is how both are fixed.
 */
import { createHmac } from 'node:crypto';
import { SQL } from 'bun';
import type { Config } from './env.ts';

/**
 * The SQLSTATE Postgres answered with.
 *
 * Bun puts it on `errno`; `code` is `ERR_POSTGRES_SERVER_ERROR` for every
 * server error and so says nothing.
 */
export function sqlState(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'errno' in cause
    ? String((cause as { errno: unknown }).errno)
    : '';
}

const DUPLICATE_OBJECT = '42710';
const DUPLICATE_DATABASE = '42P04';
/** The site's database is not there. */
export const UNDEFINED_DATABASE = '3D000';
/** The site's role does not take the password this process derived. */
export const INVALID_PASSWORD = '28P01';
/** `statement_timeout` fired. */
export const QUERY_CANCELED = '57014';
/** A client id that is already in the collection. */
export const UNIQUE_VIOLATION = '23505';

/** What a site name may be once it is a Postgres identifier. */
const IDENT = /^[a-z0-9][a-z0-9_-]*$/;
/** base64url, which is what an HMAC digest is rendered as. */
const DERIVED = /^[A-Za-z0-9_-]+$/;
/** A claimed kthx name — narrower than an identifier, and never underscored. */
const SITE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * The last line before a name reaches SQL text.
 *
 * Site names are validated on claim and identifiers are quoted, so this can
 * never fire; it is here because `CREATE DATABASE` takes no parameters and a
 * future caller that forgets where its string came from should crash rather
 * than compose.
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

/** The password a site's role has, derived from the key and the name. */
export function sitePassword(key: string, name: string): string {
  return createHmac('sha256', key).update(`pg:${name}`).digest('base64url');
}

/**
 * The same server, a different database — and, for a site, a different role.
 *
 * Every search parameter of the control URL is dropped: the one the test
 * harness sets is a `search_path` into its own schema, which exists in the
 * control database and nowhere else.
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
 * What a site's own connections are held to.
 *
 * Two seconds is longer than any query this API can build and shorter than a
 * request anyone waits for; the transaction timeout is what keeps a client
 * that opened one and vanished from holding a connection out of a pool of two.
 */
const SITE_OPTIONS =
  '-c search_path=public -c statement_timeout=2000 -c idle_in_transaction_session_timeout=5000';

/** Sites whose pool is open at once, oldest closed first. */
export const MAX_POOLS = 64;
/** How long a site's snapshot of its own size is believed. */
const SNAPSHOT_MS = 10_000;

/** The size a site's database is, and which collections it holds. */
export interface Snapshot {
  readonly bytes: number;
  readonly collections: Set<string>;
}

/** Thrown when the site is on its way out and its pool must not be reopened. */
export class SiteGone extends Error {
  override readonly name = 'SiteGone';
}

export class Pg {
  /** Site name → its pool, in least-recently-used order. */
  private readonly pools = new Map<string, SQL>();
  private readonly snapshots = new Map<string, Snapshot & { at: number }>();
  /** Names between `deleted_at` and `DROP DATABASE`. */
  private readonly leaving = new Set<string>();
  /** One repair per name at a time, so a burst of 503s is one round of DDL. */
  private readonly repairs = new Map<string, Promise<void>>();

  constructor(
    private readonly config: Config,
    private readonly control: SQL,
  ) {}

  /** `template_kthx` — the database every site is cloned from. */
  get template(): string {
    return `template_${this.config.pgPrefix}`;
  }

  /** `kthx_site` — the NOLOGIN role that carries the table grants. */
  get group(): string {
    return `${this.config.pgPrefix}_site`;
  }

  /**
   * The group role and the template, made once at start-up.
   *
   * The connection to the template is closed before this returns: a clone
   * fails while any session is on the source database, and the first claim
   * after a restart would otherwise race the boot.
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
      // Table grants are copied with the template, which is what saves every
      // claim a `GRANT`: the site's role is a member of the group role that
      // already holds them.
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
      // A site is small and written by anyone, so it is vacuumed on a fraction
      // of the churn the default waits for.
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
   * Steps 2–5 of a claim, and the whole of a repair.
   *
   * Idempotent by construction: an object that is already there is tolerated
   * and the password is re-applied, so this is also what fixes a site after
   * `KTHX_PG_KEY` is rotated or the cluster is restored from a dump that
   * carries no role passwords.
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
    // What `DROP DATABASE … WITH (FORCE)` needs at delete time. A CREATEROLE
    // control role is granted the roles it creates with `INHERIT FALSE`, and
    // `pg_terminate_backend` asks whether the caller has the *privileges* of
    // the backend's role — which an uninherited membership does not give. So
    // the control role takes the site's privileges (it owns the database
    // anyway) and not `SET`, which would let it act as the site.
    await this.control.unsafe(
      `grant ${q(name)} to current_user with inherit true, set false`,
    );
    await this.tolerate(
      DUPLICATE_DATABASE,
      `create database ${q(name)} template ${q(this.template)}`,
    );
    // Database ACLs are not copied from a template, so this is the statement
    // that makes one site's database unreachable from another site's role.
    await this.control.unsafe(
      `revoke connect, temp on database ${q(name)} from public`,
    );
    await this.control.unsafe(
      `grant connect on database ${q(name)} to ${q(name)}`,
    );
    await this.control`
      update sites set provisioned_at = now() where name = ${name}
    `;
    this.pools.delete(name);
    this.snapshots.delete(name);
  }

  /** Whether this name is already a database or a role, which makes it taken. */
  async inUse(name: string): Promise<boolean> {
    const [row] = (await this.control`
      select exists (select 1 from pg_database where datname = ${name})
          or exists (select 1 from pg_roles where rolname = ${name}) as taken
    `) as { taken: boolean }[];
    return row?.taken ?? false;
  }

  /**
   * Run something against a site's own database, as the site's own role.
   *
   * A connection refused because the database or the password is not what this
   * process expects is repaired once and retried: that is a site claimed by an
   * older key, or one restored from a dump, and the repair is the same DDL a
   * claim runs.
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

  /** The pool for a site, opened lazily and closed when 64 newer ones exist. */
  private pool(name: string): SQL {
    if (this.leaving.has(name)) throw new SiteGone(`${name} is being deleted`);
    const open = this.pools.get(name);
    if (open !== undefined) {
      // Re-inserting is what makes this map an LRU: iteration order is
      // insertion order, so the first key is the least recently used.
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

  /** Re-run provisioning, once per name at a time. */
  async repair(name: string): Promise<void> {
    const running = this.repairs.get(name);
    if (running !== undefined) return running;
    const attempt = this.provision(name).finally(() => {
      this.repairs.delete(name);
    });
    this.repairs.set(name, attempt);
    return attempt;
  }

  /**
   * Every live site's role given the password this key derives.
   *
   * Run at start-up in the background: after a restore or a key rotation every
   * site is unreachable until this passes, and a site that is touched first is
   * repaired by {@link site} anyway.
   */
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

  /**
   * The contract's delete order: the pool goes, its queries are given until
   * the drain deadline, and only then is the database dropped.
   */
  async drop(name: string): Promise<void> {
    this.leaving.add(name);
    try {
      const pool = this.pools.get(name);
      this.pools.delete(name);
      this.snapshots.delete(name);
      // Bun waits for the queries already in flight and then closes; `FORCE`
      // is what deals with anything that outlasts the deadline.
      await pool?.close({ timeout: 5 });
      await this.control.unsafe(
        `drop database if exists ${q(name)} with (force)`,
      );
      await this.control.unsafe(`drop role if exists ${q(name)}`);
    } finally {
      this.leaving.delete(name);
    }
  }

  /** `pg_database_size`, which is the meter a site's quota is read from. */
  async bytes(name: string): Promise<number> {
    try {
      const [row] = (await this.control`
        select pg_database_size(${name})::bigint as bytes
      `) as { bytes: string | number }[];
      return Number(row?.bytes ?? 0);
    } catch {
      // A site whose database is not there yet has spent nothing.
      return 0;
    }
  }

  /**
   * What a growing write is measured against, refreshed at most every ten
   * seconds per site.
   *
   * Both numbers are cheap to be a little stale: the byte ceiling is a quota
   * with megabytes of slack, and a collection created inside the window is
   * added to the set by {@link noteCollection} rather than waited for.
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

  /** A collection this process just created, so the window does not miss it. */
  noteCollection(name: string, collection: string): void {
    this.snapshots.get(name)?.collections.add(collection);
  }

  /**
   * Databases and roles no live site row names.
   *
   * The residue of a claim that failed between `CREATE DATABASE` and its row,
   * and of a delete that was interrupted. Bounded to names that could be a
   * site: nothing reserved, nothing the control plane itself needs.
   *
   * ponytail: `consider` exists so a test can confine the sweep to the names
   * it made — the production call passes nothing and sweeps the cluster, which
   * is correct there because one kthx owns the whole of it.
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
    // Only what a claim could have made. `SITE_NAME` is the narrow one — no
    // underscore, three characters at least — which is what keeps this off
    // `streaming_replica`, `template_kthx` and every other name the cluster
    // gives itself.
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
    const roles = (await this.control`
      select rolname as name from pg_roles r
      where not rolsuper
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

  /** Run a statement, treating one SQLSTATE as "it was already there". */
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
