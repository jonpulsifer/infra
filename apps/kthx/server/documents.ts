/**
 * `/api/db`: collections of JSON documents in the site's own database.
 *
 * Two rules shape everything here. **Every write is one statement** — the merge
 * a `PATCH` performs, the etag it recomputes and the size ceiling it is held to
 * all live in the `UPDATE`, so two tabs racing on a document cannot interleave
 * a read and a write. And **nothing a caller sends reaches SQL text**: field
 * paths become chained `->` operators over text parameters, values become
 * `jsonb` parameters, and the only strings this file composes are its own.
 *
 * Equality is written twice on purpose — `data @> {path: value}` engages the
 * GIN index and is loose about arrays, `data -> path = value` is exact and is
 * not indexed — because either alone is wrong: containment would match a `1`
 * stored inside `[1,2]`, and the exact half would scan.
 */
import { randomUUID } from 'node:crypto';
import { type Code, empty, isJson, logCause, ok, refuse } from './http.ts';
import { QUERY_CANCELED, SiteGone, sqlState, UNIQUE_VIOLATION } from './pg.ts';
import { framed, publishDocument } from './realtime.ts';
import type { Ctx } from './sites.ts';

export const MAX_DOC_BYTES = 1024 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_BULK = 100;
export const MAX_LIST = 500;
export const DEFAULT_LIST = 100;
export const MAX_OFFSET = 10_000;
export const MAX_WHERE_KEYS = 16;
export const MAX_IN_VALUES = 100;
export const MAX_PATTERN_CHARS = 256;
export const MAX_DEPTH = 32;
export const MAX_DOC_KEYS = 10_000;

const COLLECTION = /^[a-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A dotted path into `data`: eight segments at most, and no quoting to do. */
const DATA_PATH = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+){0,7}$/;
const ISO =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

/** The four keys the server owns; a caller's copies are dropped before storing. */
const SERVER_KEYS = new Set(['id', 'created_at', 'updated_at', 'etag']);

const COLUMNS = 'id, data, etag, created_at, updated_at';

/** Postgres's canonical text of the value, hashed where it is written. */
const etagOf = (expr: string) =>
  `encode(sha256(convert_to((${expr})::text,'UTF8')),'hex')`;

/** The document ceiling, applied to what the statement is about to store. */
const fits = (expr: string) =>
  `octet_length((${expr})::text) <= ${MAX_DOC_BYTES}`;

interface Row {
  readonly id: string;
  readonly data: Record<string, unknown>;
  readonly etag: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

/** `{id, created_at, updated_at, etag, ...data}` — the shape on the wire. */
function wire(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    etag: row.etag,
    ...row.data,
  };
}

function iso(at: Date | string): string {
  return (at instanceof Date ? at : new Date(at)).toISOString();
}

// --- parameters -------------------------------------------------------------

/** Collects the values a composed statement binds, in order. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }

  /** A JSON value as a `jsonb` parameter. */
  jsonb(value: unknown): string {
    return json(this.add(JSON.stringify(value)));
  }
}

/**
 * A parameter carrying JSON text, as `jsonb`.
 *
 * The two-step cast is not decoration: bound straight to `$1::jsonb`, Bun
 * encodes a JS string as a JSON *string*, so `{"a":1}` arrives as the six
 * characters rather than as an object. Pinning the parameter to `text` first
 * makes Postgres do the parsing, which is the behaviour every statement here
 * is written against.
 */
const json = (ref: string) => `(${ref}::text)::jsonb`;

/**
 * A field of a document, as three ways of naming the same thing.
 *
 * `id`, `created_at` and `updated_at` are columns; everything else is a path
 * into `data`, reached by chaining `->` over one text parameter per segment,
 * which is what keeps a caller's path out of the SQL text.
 */
interface Field {
  /** The comparable expression: `jsonb` for a path, the column otherwise. */
  readonly value: string;
  /** The same field as text, for `$like`/`$ilike`. */
  readonly text: string;
  readonly kind: 'jsonb' | 'text' | 'time';
  /** Wraps a value into the object `data @> …` takes, for a path. */
  readonly contain: ((value: unknown) => unknown) | null;
}

function fieldOf(path: string, p: Params): Field | null {
  if (path === 'id') {
    return { value: 'id', text: 'id', kind: 'text', contain: null };
  }
  if (path === 'created_at' || path === 'updated_at') {
    return {
      value: path,
      text: `${path}::text`,
      kind: 'time',
      contain: null,
    };
  }
  if (path.length > 128 || !DATA_PATH.test(path)) return null;
  const parts = path.split('.');
  const refs = parts.map((part) => `${p.add(part)}::text`);
  const head = refs
    .slice(0, -1)
    .map((ref) => ` -> ${ref}`)
    .join('');
  const last = refs[refs.length - 1];
  return {
    value: `(data${head} -> ${last})`,
    text: `(data${head} ->> ${last})`,
    kind: 'jsonb',
    contain: (value) =>
      parts.reduceRight<unknown>((nested, key) => ({ [key]: nested }), value),
  };
}

const RANGE: Record<string, string> = {
  $gt: '>',
  $gte: '>=',
  $lt: '<',
  $lte: '<=',
};

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** One field's value, cast the way its kind compares. */
function literal(field: Field, value: unknown, p: Params): string | null {
  if (field.kind === 'jsonb') return p.jsonb(value);
  if (field.kind === 'time') {
    if (typeof value !== 'string' || !ISO.test(value)) return null;
    return `${p.add(value)}::timestamptz`;
  }
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  return `${p.add(String(value))}::text`;
}

/** The same, as an array, built from one jsonb parameter. */
function literals(field: Field, values: unknown[], p: Params): string | null {
  if (values.length > MAX_IN_VALUES || !values.every(isScalar)) return null;
  const list = p.jsonb(values);
  if (field.kind === 'jsonb') {
    return `array(select e from jsonb_array_elements(${list}) e)`;
  }
  if (field.kind === 'time') {
    if (!values.every((v) => typeof v === 'string' && ISO.test(v))) return null;
    return `array(select e::timestamptz from jsonb_array_elements_text(${list}) e)`;
  }
  return `array(select e from jsonb_array_elements_text(${list}) e)`;
}

/** One `where` entry as SQL, or `null` when the grammar does not have it. */
function condition(field: Field, raw: unknown, p: Params): string | null {
  const operator =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? Object.keys(raw).find((key) => key.startsWith('$'))
      : undefined;
  if (operator === undefined) {
    // A plain value: exact equality, indexed by its containment half.
    const value = literal(field, raw, p);
    if (value === null) return null;
    if (field.contain === null) return `${field.value} = ${value}`;
    const contained = p.jsonb(field.contain(raw));
    return `(data @> ${contained} and ${field.value} = ${value})`;
  }

  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length !== 1) return null;
  const value = (raw as Record<string, unknown>)[operator];

  if (operator in RANGE) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const bound = literal(field, value, p);
    return bound === null ? null : `${field.value} ${RANGE[operator]} ${bound}`;
  }
  if (operator === '$ne') {
    const bound = literal(field, value, p);
    return bound === null ? null : `${field.value} is distinct from ${bound}`;
  }
  if (operator === '$in' || operator === '$nin') {
    if (!Array.isArray(value)) return null;
    const list = literals(field, value, p);
    if (list === null) return null;
    return operator === '$in'
      ? `${field.value} = any (${list})`
      : `(${field.value} is null or not (${field.value} = any (${list})))`;
  }
  if (operator === '$like' || operator === '$ilike') {
    if (typeof value !== 'string' || value.length > MAX_PATTERN_CHARS) {
      return null;
    }
    const like = operator === '$like' ? 'like' : 'ilike';
    return `${field.text} ${like} ${p.add(value)}::text`;
  }
  if (operator === '$exists') {
    if (typeof value !== 'boolean') return null;
    return `${field.value} is ${value ? 'not null' : 'null'}`;
  }
  return null;
}

function whereOf(raw: unknown, p: Params): string | null {
  if (raw === undefined || raw === null) return 'true';
  if (typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_WHERE_KEYS) return null;
  const parts: string[] = [];
  for (const [path, value] of entries) {
    if (!nestingOk(value, 1)) return null;
    const field = fieldOf(path, p);
    if (field === null) return null;
    const clause = condition(field, value, p);
    if (clause === null) return null;
    parts.push(clause);
  }
  return parts.length === 0 ? 'true' : parts.join(' and ');
}

function orderOf(raw: unknown, p: Params): string | null {
  const spec = raw === undefined || raw === null ? 'created_at desc' : raw;
  if (typeof spec !== 'string') return null;
  const [path = '', direction = 'asc', ...rest] = spec.trim().split(/\s+/);
  if (rest.length > 0) return null;
  const dir = direction.toLowerCase();
  if (dir !== 'asc' && dir !== 'desc') return null;
  const field = fieldOf(path, p);
  if (field === null) return null;
  // `id` last so a page boundary is stable when the ordered values tie.
  return `order by ${field.value} ${dir}, id asc`;
}

function nestingOk(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) {
    return value.every((item) => nestingOk(item, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.values(value).every((item) => nestingOk(item, depth + 1));
  }
  return true;
}

function whole(raw: unknown, fallback: number): number | null {
  if (raw === undefined || raw === null) return fallback;
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

interface Query {
  readonly where?: unknown;
  readonly orderBy?: unknown;
  readonly limit?: unknown;
  readonly offset?: unknown;
}

/** The statement a query becomes, or `null` when the grammar rejects it. */
function compile(
  collection: string,
  query: Query,
  counting: boolean,
): { text: string; values: unknown[] } | null {
  const p = new Params();
  const where = whereOf(query.where, p);
  if (where === null) return null;
  const collectionRef = p.add(collection);
  const scope = `collection = ${collectionRef}::text and (${where})`;
  if (counting) {
    return {
      text: `select count(*)::int as count from documents where ${scope}`,
      values: p.values,
    };
  }
  const order = orderOf(query.orderBy, p);
  if (order === null) return null;
  // A limit past the ceiling is clamped, an offset past it is refused: asking
  // for more rows than a page holds is a client that did not read the docs,
  // asking for page 400 is a client that will paginate for ever.
  const limit = whole(query.limit, DEFAULT_LIST);
  const offset = whole(query.offset, 0);
  if (limit === null || offset === null || offset > MAX_OFFSET) return null;
  return {
    text: `select ${COLUMNS} from documents where ${scope} ${order}
      limit ${p.add(Math.min(limit, MAX_LIST))}::int offset ${p.add(offset)}::int`,
    values: p.values,
  };
}

// --- documents --------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether this is a document: an object, without NUL, not too deep, not too
 * wide, and without the three keys a prototype pollution gadget looks for.
 */
export function validDocument(
  value: unknown,
): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    if (Object.hasOwn(value, key)) return false;
  }
  let keys = 0;
  const walk = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (typeof node === 'string') return !node.includes('\0');
    if (Array.isArray(node)) return node.every((item) => walk(item, depth + 1));
    if (typeof node === 'object' && node !== null) {
      for (const [key, item] of Object.entries(node)) {
        keys += 1;
        if (keys > MAX_DOC_KEYS || key.includes('\0')) return false;
        if (!walk(item, depth + 1)) return false;
      }
    }
    return true;
  };
  return walk(value, 1);
}

/** The document without the four keys the server writes. */
function stored(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!SERVER_KEYS.has(key)) out[key] = value;
  }
  return out;
}

function tooLarge(data: Record<string, unknown>): boolean {
  return Buffer.byteLength(JSON.stringify(data)) > MAX_DOC_BYTES;
}

// --- the API ----------------------------------------------------------------

/** The three headers a write reads. */
interface Preconditions {
  /** The bare etag, `*`, or `null` when no `If-Match` was sent. */
  readonly ifMatch: string | null;
  readonly ifNoneMatchAny: boolean;
}

function preconditions(request: Request): Preconditions {
  const raw = request.headers.get('if-match');
  return {
    ifMatch: raw === null ? null : raw.trim().replace(/^"|"$/g, ''),
    ifNoneMatchAny: (request.headers.get('if-none-match') ?? '').trim() === '*',
  };
}

function withEtag(
  body: Record<string, unknown>,
  ctx: Ctx,
  status: number,
): Response {
  return ok(body, ctx.id, status, 'no-store', {
    etag: `"${String(body.etag)}"`,
  });
}

async function bodyOf(
  request: Request,
): Promise<{ json: unknown } | { code: Code }> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
    return { code: 'TOO_LARGE' };
  }
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) return { code: 'TOO_LARGE' };
  try {
    return { json: JSON.parse(text) as unknown };
  } catch {
    return { code: 'MALFORMED_REQUEST' };
  }
}

/**
 * Dispatch under `/api/db`, given the split path.
 *
 * `segments` is `['', 'api', 'db', collection?, id?]`; `owner` says whether the
 * request carried this site's bearer, which is what `DELETE /api/db/:c` needs.
 */
export async function dbApi(
  request: Request,
  ctx: Ctx,
  site: string,
  segments: readonly string[],
  owner: boolean,
): Promise<Response> {
  try {
    return await route(request, ctx, site, segments, owner);
  } catch (cause) {
    if (cause instanceof SiteGone) return refuse('GONE', ctx.id);
    if (sqlState(cause) === QUERY_CANCELED) {
      logCause(ctx.id, 'a site query ran past its timeout', cause);
      return refuse('BUSY', ctx.id);
    }
    throw cause;
  }
}

async function route(
  request: Request,
  ctx: Ctx,
  site: string,
  segments: readonly string[],
  owner: boolean,
): Promise<Response> {
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';

  if (segments.length === 3) {
    if (!read) return refuse('METHOD_NOT_ALLOWED', ctx.id);
    const rows = await ctx.pg.site(site, async (sql) =>
      sql`
        select collection as name, count(*)::int as count
        from documents group by 1 order by 1
      `.then((r) => r as { name: string; count: number }[]),
    );
    return ok({ collections: rows }, ctx.id);
  }
  if (segments.length > 5) return refuse('NOT_FOUND', ctx.id);

  const collection = decode(segments[3]);
  if (collection === null || !COLLECTION.test(collection)) {
    return refuse('INVALID_COLLECTION', ctx.id);
  }

  // `…/query` is a POST sub-path; every other verb on it names a document.
  if (segments.length === 5 && segments[4] === 'query' && method === 'POST') {
    return query(request, ctx, site, collection);
  }
  if (segments.length === 4) {
    if (read) return list(request, ctx, site, collection);
    if (method === 'POST') return create(request, ctx, site, collection);
    if (method === 'DELETE') {
      if (!owner) {
        return refuse(
          request.headers.get('authorization') === null
            ? 'UNAUTHENTICATED'
            : 'FORBIDDEN',
          ctx.id,
        );
      }
      await ctx.pg.site(site, async (sql) => {
        await sql`delete from documents where collection = ${collection}`;
      });
      return empty(ctx.id);
    }
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }

  const id = decode(segments[4]);
  if (id === null || !ID.test(id)) return refuse('INVALID_ID', ctx.id);
  if (read) return one(ctx, site, collection, id);
  if (method === 'PATCH') return patch(request, ctx, site, collection, id);
  if (method === 'PUT') return put(request, ctx, site, collection, id);
  if (method === 'DELETE') return remove(request, ctx, site, collection, id);
  return refuse('METHOD_NOT_ALLOWED', ctx.id);
}

function decode(segment: string | undefined): string | null {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return null;
  }
}

// --- reads ------------------------------------------------------------------

async function list(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  let where: unknown;
  const raw = params.get('where');
  if (raw !== null) {
    try {
      where = JSON.parse(raw);
    } catch {
      return refuse('INVALID_QUERY', ctx.id);
    }
  }
  return run(ctx, site, collection, {
    where,
    orderBy: params.get('orderBy') ?? undefined,
    limit: params.get('limit') ?? undefined,
    offset: params.get('offset') ?? undefined,
  });
}

async function query(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  if (!isPlainObject(body.json)) return refuse('INVALID_QUERY', ctx.id);
  return run(ctx, site, collection, body.json, body.json.count === true);
}

async function run(
  ctx: Ctx,
  site: string,
  collection: string,
  query: Query,
  counting = false,
): Promise<Response> {
  const items = compile(collection, query, false);
  if (items === null) return refuse('INVALID_QUERY', ctx.id);
  const total = counting ? compile(collection, query, true) : null;
  if (counting && total === null) return refuse('INVALID_QUERY', ctx.id);

  return ctx.pg.site(site, async (sql) => {
    const rows = (await sql.unsafe(items.text, items.values)) as Row[];
    const body: Record<string, unknown> = { items: rows.map(wire) };
    if (total !== null) {
      const [counted] = (await sql.unsafe(total.text, total.values)) as {
        count: number;
      }[];
      body.count = counted?.count ?? 0;
    }
    return ok(body, ctx.id);
  });
}

async function one(
  ctx: Ctx,
  site: string,
  collection: string,
  id: string,
): Promise<Response> {
  const row = await ctx.pg.site(site, async (sql) => {
    const [found] = (await sql`
      select id, data, etag, created_at, updated_at from documents
      where collection = ${collection} and id = ${id}
    `) as Row[];
    return found;
  });
  if (row === undefined) return refuse('NOT_FOUND', ctx.id);
  return withEtag(wire(row), ctx, 200);
}

// --- writes -----------------------------------------------------------------

/** What a growing write is allowed, given the site's ten-second snapshot. */
async function room(
  ctx: Ctx,
  site: string,
  collection: string | null,
): Promise<boolean> {
  const snapshot = await ctx.pg.snapshot(site);
  if (snapshot.bytes >= ctx.config.maxDbBytes) return false;
  if (collection === null || snapshot.collections.has(collection)) return true;
  return snapshot.collections.size < ctx.config.maxCollections;
}

async function create(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  const many = Array.isArray(body.json);
  const documents = (many ? body.json : [body.json]) as unknown[];
  if (many && (documents.length === 0 || documents.length > MAX_BULK)) {
    return refuse(
      documents.length > MAX_BULK ? 'TOO_LARGE' : 'INVALID_DOCUMENT',
      ctx.id,
    );
  }

  const rows: { id: string; data: Record<string, unknown> }[] = [];
  for (const document of documents) {
    if (!validDocument(document)) return refuse('INVALID_DOCUMENT', ctx.id);
    const supplied = document.id;
    if (
      supplied !== undefined &&
      (typeof supplied !== 'string' || !ID.test(supplied))
    ) {
      return refuse('INVALID_ID', ctx.id);
    }
    const data = stored(document);
    if (tooLarge(data)) return refuse('TOO_LARGE', ctx.id);
    rows.push({ id: (supplied as string | undefined) ?? randomUUID(), data });
  }
  if (!(await room(ctx, site, collection))) {
    return refuse('SITE_FULL', ctx.id);
  }

  const written = await ctx.pg
    .site(site, async (sql) =>
      many
        ? ((await sql.unsafe(
            `insert into documents (collection, id, data, etag)
             select $1::text, e.id, e.data, ${etagOf('e.data')}
             from jsonb_to_recordset(${json('$2')}) as e(id text, data jsonb)
             returning ${COLUMNS}`,
            [collection, JSON.stringify(rows)],
          )) as Row[])
        : ((await sql.unsafe(
            `insert into documents (collection, id, data, etag)
             values ($1::text, $2::text, ${json('$3')}, ${etagOf(json('$3'))})
             on conflict do nothing returning ${COLUMNS}`,
            [collection, rows[0]?.id, JSON.stringify(rows[0]?.data)],
          )) as Row[]),
    )
    .catch((cause: unknown) => {
      if (sqlState(cause) === UNIQUE_VIOLATION) return null;
      throw cause;
    });
  if (written === null || written.length === 0) {
    return refuse('EXISTS', ctx.id);
  }

  ctx.pg.noteCollection(site, collection);
  const order = new Map(rows.map((row, index) => [row.id, index]));
  const wired = written
    .slice()
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map(wire);
  for (const document of wired)
    announce(ctx, site, collection, 'create', document);
  return many
    ? ok({ items: wired }, ctx.id, 201)
    : withEtag(wired[0] as Record<string, unknown>, ctx, 201);
}

async function patch(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
  id: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  if (!validDocument(body.json)) return refuse('INVALID_DOCUMENT', ctx.id);
  const overwrite = new URL(request.url).searchParams.get('overwrite') === '1';
  const data = stored(body.json);
  if (overwrite && tooLarge(data)) return refuse('TOO_LARGE', ctx.id);
  if (!(await room(ctx, site, null))) return refuse('SITE_FULL', ctx.id);

  const { ifMatch } = preconditions(request);
  const merged = overwrite ? json('$3') : `data || ${json('$3')}`;
  const values: unknown[] = [collection, id, JSON.stringify(data)];
  let text = `update documents set data = ${merged}, etag = ${etagOf(merged)},
      updated_at = now()
    where collection = $1::text and id = $2::text and ${fits(merged)}`;
  if (ifMatch !== null && ifMatch !== '*') {
    values.push(ifMatch);
    text += ' and etag = $4::text';
  }
  text += ` returning ${COLUMNS}`;

  const [row] = await ctx.pg.site(
    site,
    async (sql) => (await sql.unsafe(text, values)) as Row[],
  );
  if (row === undefined)
    return await refused(ctx, site, collection, id, ifMatch);
  const document = wire(row);
  announce(ctx, site, collection, 'update', document);
  return withEtag(document, ctx, 200);
}

async function put(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
  id: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  if (!validDocument(body.json)) return refuse('INVALID_DOCUMENT', ctx.id);
  const data = stored(body.json);
  if (tooLarge(data)) return refuse('TOO_LARGE', ctx.id);
  if (!(await room(ctx, site, collection))) return refuse('SITE_FULL', ctx.id);

  const { ifMatch, ifNoneMatchAny } = preconditions(request);
  let text: string;
  const values: unknown[] = [collection, id, JSON.stringify(data)];
  if (ifNoneMatchAny) {
    text = `insert into documents (collection, id, data, etag)
      values ($1::text, $2::text, ${json('$3')}, ${etagOf(json('$3'))})
      on conflict do nothing returning ${COLUMNS}, true as created`;
  } else if (ifMatch !== null) {
    text = `update documents set data = ${json('$3')},
        etag = ${etagOf(json('$3'))}, updated_at = now()
      where collection = $1::text and id = $2::text`;
    if (ifMatch !== '*') {
      values.push(ifMatch);
      text += ' and etag = $4::text';
    }
    text += ` returning ${COLUMNS}, false as created`;
  } else {
    text = `insert into documents (collection, id, data, etag)
      values ($1::text, $2::text, ${json('$3')}, ${etagOf(json('$3'))})
      on conflict (collection, id) do update
        set data = excluded.data, etag = excluded.etag, updated_at = now()
      returning ${COLUMNS}, (xmax = 0) as created`;
  }

  const [row] = await ctx.pg.site(
    site,
    async (sql) =>
      (await sql.unsafe(text, values)) as (Row & { created: boolean })[],
  );
  if (row === undefined) return refuse('PRECONDITION_FAILED', ctx.id);
  ctx.pg.noteCollection(site, collection);
  const document = wire(row);
  announce(ctx, site, collection, row.created ? 'create' : 'update', document);
  return withEtag(document, ctx, row.created ? 201 : 200);
}

async function remove(
  request: Request,
  ctx: Ctx,
  site: string,
  collection: string,
  id: string,
): Promise<Response> {
  const { ifMatch } = preconditions(request);
  const values: unknown[] = [collection, id];
  let text =
    'delete from documents where collection = $1::text and id = $2::text';
  if (ifMatch !== null && ifMatch !== '*') {
    values.push(ifMatch);
    text += ' and etag = $3::text';
  }
  text += ' returning id';

  const rows = await ctx.pg.site(
    site,
    async (sql) => (await sql.unsafe(text, values)) as { id: string }[],
  );
  if (rows.length === 0) {
    // Deleting what is not there is a 204 — unless the caller said which
    // version it meant, in which case it did not get it.
    return ifMatch === null
      ? empty(ctx.id)
      : refuse('PRECONDITION_FAILED', ctx.id);
  }
  publishDocument(
    ctx.server,
    site,
    { t: 'delete', collection, id },
    collection,
  );
  return empty(ctx.id);
}

/**
 * Why a one-statement update wrote nothing: the document is not there, the
 * caller named a version that is not the current one, or the merge would have
 * been over the ceiling. Only ever run on the failure path.
 */
async function refused(
  ctx: Ctx,
  site: string,
  collection: string,
  id: string,
  ifMatch: string | null,
): Promise<Response> {
  const [row] = await ctx.pg.site(site, async (sql) => {
    return (await sql`
      select etag from documents where collection = ${collection} and id = ${id}
    `) as { etag: string }[];
  });
  if (row === undefined) return refuse('NOT_FOUND', ctx.id);
  if (ifMatch !== null && ifMatch !== '*' && ifMatch !== row.etag) {
    return refuse('PRECONDITION_FAILED', ctx.id);
  }
  return refuse('TOO_LARGE', ctx.id);
}

function announce(
  ctx: Ctx,
  site: string,
  collection: string,
  t: 'create' | 'update',
  document: Record<string, unknown>,
): void {
  publishDocument(
    ctx.server,
    site,
    {
      t,
      collection,
      id: document.id,
      etag: document.etag,
      doc: framed(document),
    },
    collection,
  );
}
