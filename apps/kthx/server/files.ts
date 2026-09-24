/**
 * `/api/files` and `/files/*`: a site's file store. Anyone on the site origin
 * may upload; only the creating visitor or the site's bearer may replace or
 * delete a path. Rows live in the control database; bytes go through to the depot.
 */
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SQL } from 'bun';
import { bodyWithin, empty, logCause, ok, refuse, siteUrl } from './http.ts';
import type { Me } from './me.ts';
import { fileAt } from './serve.ts';
import type { Ctx } from './sites.ts';

/** One file, and everything a site may hold. */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_FILES_BYTES = 256 * 1024 * 1024;
export const MAX_FILES = 1000;

/** How many bodies may be arriving at once, process-wide. */
const MAX_PUTS = 8;
/** Concurrent depot deletes during a site teardown. */
const DELETE_WIDTH = 16;
/** The same deadline a release body gets. */
const BODY_TIMEOUT_MS = 120_000;

const PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const MAX_PATH_CHARS = 256;
const MAX_SEGMENT_BYTES = 128;

/** A media type as RFC 9110 writes one, bounded so a header cannot be smuggled. */
const MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/;

/**
 * Never HTML, SVG, JavaScript or XML: served from the site origin, those run
 * script as the site.
 */
const ALLOWED_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv',
  'text/markdown',
]);

/** Families a browser renders and never executes. */
const ALLOWED_FAMILIES: ReadonlySet<string> = new Set([
  'image',
  'audio',
  'video',
]);

/** Everything else is served as an attachment. */
function inline(type: string): boolean {
  const family = type.split('/')[0] ?? '';
  return (
    ALLOWED_FAMILIES.has(family) ||
    family === 'text' ||
    type === 'application/pdf'
  );
}

/**
 * Only the header decides the stored type. Nothing sniffs the bytes and
 * `nosniff` stops the browser, so a `.html` sent as `text/plain` stays text.
 */
export function allowedType(header: string | null): string | null {
  const media = (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (!MEDIA_TYPE.test(media)) return null;
  const [family = '', subtype = ''] = media.split('/');
  // Any SVG or `+xml` subtype can carry script, whatever its family.
  if (subtype.includes('svg') || subtype.endsWith('+xml')) return null;
  if (ALLOWED_TYPES.has(media)) return media;
  return ALLOWED_FAMILIES.has(family) ? media : null;
}

export function legalPath(path: string): boolean {
  if (path.length === 0 || path.length > MAX_PATH_CHARS) return false;
  if (!PATH.test(path)) return false;
  const encoder = new TextEncoder();
  return path
    .split('/')
    .every(
      (segment) => encoder.encode(segment).byteLength <= MAX_SEGMENT_BYTES,
    );
}

interface FileRow {
  readonly path: string;
  readonly owner: string;
  readonly size: string | number;
  readonly type: string;
  readonly sha256: string;
  readonly updated_at: Date;
}

type Listed = Omit<FileRow, 'owner' | 'sha256'>;

/** What a failed `PUT` restores. */
type Existing = Omit<FileRow, 'path'>;

/** Beside the site's release directories, never inside one. */
export function filesDir(sitesDir: string, site: string): string {
  return join(sitesDir, site, 'files');
}

function objectName(site: string, path: string): string {
  return `files/${site}/${path}`;
}

/** For `usage.files_bytes`. */
export async function filesBytes(sql: SQL, site: string): Promise<number> {
  const [row] = (await sql`
    select coalesce(sum(size), 0)::bigint as bytes from files where site = ${site}
  `) as { bytes: string | number }[];
  return Number(row?.bytes ?? 0);
}

/**
 * Object names come from the rows, so the rows are read before they are
 * deleted. The caller removes the bytes on the volume.
 */
export async function dropFiles(ctx: Ctx, site: string): Promise<void> {
  const rows = (await ctx.sql`
    select path from files where site = ${site}
  `) as { path: string }[];
  await ctx.sql`delete from files where site = ${site}`;
  // Batched: a full site is a thousand depot deletes, inside a request the edge
  // cuts off at 100 s.
  for (let at = 0; at < rows.length; at += DELETE_WIDTH) {
    await Promise.all(
      rows.slice(at, at + DELETE_WIDTH).map((row) =>
        ctx.depot.delete(objectName(site, row.path)).catch((cause: unknown) => {
          logCause(ctx.id, `deleting ${objectName(site, row.path)}`, cause);
        }),
      ),
    );
  }
}

let putting = 0;

/** `null` when every process-wide `PUT` slot is held. */
function takePut(): (() => void) | null {
  if (putting >= MAX_PUTS) return null;
  putting += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    putting -= 1;
  };
}

/**
 * Bytes accepted but not yet recorded, counted against the site's budget so
 * concurrent `PUT`s cannot each pass a quota check the others invalidate.
 */
const pending = new Map<string, number>();

function reserve(site: string, size: number): () => void {
  pending.set(site, (pending.get(site) ?? 0) + size);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (pending.get(site) ?? 0) - size;
    if (left > 0) pending.set(site, left);
    else pending.delete(site);
  };
}

/** One writer per path, so the ownership check, the bytes and the row agree. */
// ponytail: in-process, sound while the server runs one replica; a second
// replica needs `select … for update` on the row.
const held = new Map<string, Promise<unknown>>();

async function underLock<T>(key: string, act: () => Promise<T>): Promise<T> {
  const before = held.get(key);
  const mine = (async () => {
    await before?.catch(() => undefined);
    return act();
  })();
  held.set(key, mine);
  try {
    return await mine;
  } finally {
    if (held.get(key) === mine) held.delete(key);
  }
}

/** `path` is the decoded pathname. */
export async function filesApi(
  request: Request,
  ctx: Ctx,
  site: string,
  path: string,
  me: Me,
  owner: boolean,
): Promise<Response> {
  const method = request.method;
  if (path === '/api/files' || path === '/api/files/') {
    if (method !== 'GET') return refuse('METHOD_NOT_ALLOWED', ctx.id);
    return list(ctx, site);
  }
  const file = path.slice('/api/files/'.length);
  if (method === 'PUT') return put(request, ctx, site, file, me, owner);
  if (method === 'DELETE') return remove(ctx, site, file, me, owner);
  return refuse('METHOD_NOT_ALLOWED', ctx.id);
}

async function list(ctx: Ctx, site: string): Promise<Response> {
  // No `owner`: the listing is public, and a visitor id identifies a person.
  const rows = (await ctx.sql`
    select path, size, type, updated_at from files
    where site = ${site} order by path
  `) as Listed[];
  return ok(
    {
      items: rows.map((row) => ({
        path: row.path,
        url: fileUrl(ctx, site, row.path),
        size: Number(row.size),
        type: row.type,
        updated_at: row.updated_at.toISOString(),
      })),
    },
    ctx.id,
  );
}

/** Absolute, because the `PUT` answer and `kthx.files.url` are the same string. */
function fileUrl(ctx: Ctx, site: string, path: string): string {
  return `${siteUrl(ctx.config.zone, site, ctx.port)}/files/${path}`;
}

async function put(
  request: Request,
  ctx: Ctx,
  site: string,
  path: string,
  me: Me,
  owner: boolean,
): Promise<Response> {
  if (!legalPath(path)) return refuse('INVALID_PATH', ctx.id);
  const type = allowedType(request.headers.get('content-type'));
  if (type === null) return refuse('UNSUPPORTED_TYPE', ctx.id);
  if (Number(request.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) {
    return refuse('TOO_LARGE', ctx.id);
  }

  const slot = takePut();
  if (slot === null) return refuse('BUSY', ctx.id);
  try {
    // The server's 30 s idle timeout is too short for a 25 MiB body over a phone.
    ctx.server?.timeout(request, BODY_TIMEOUT_MS / 1000 + 10);
    let bytes: Uint8Array | null;
    try {
      bytes = await bodyWithin(request, BODY_TIMEOUT_MS, MAX_FILE_BYTES);
    } catch (cause) {
      logCause(ctx.id, 'reading a file body', cause);
      return refuse('TIMEOUT', ctx.id);
    }
    if (bytes === null) return refuse('TOO_LARGE', ctx.id);
    const body = bytes;
    return await underLock(`${site}/${path}`, () =>
      store(ctx, site, path, me, owner, body, type),
    );
  } finally {
    slot();
  }
}

async function store(
  ctx: Ctx,
  site: string,
  path: string,
  me: Me,
  owner: boolean,
  bytes: Uint8Array,
  type: string,
): Promise<Response> {
  const [existing] = (await ctx.sql`
    select owner, size, type, sha256, updated_at from files
    where site = ${site} and path = ${path} limit 1
  `) as Existing[];
  if (existing !== undefined && existing.owner !== me.id && !owner) {
    return refuse('FORBIDDEN', ctx.id);
  }

  const [usage] = (await ctx.sql`
    select coalesce(sum(size), 0)::bigint as bytes, count(*)::int as files
    from files where site = ${site} and path <> ${path}
  `) as { bytes: string | number; files: number }[];
  const stored = Number(usage?.bytes ?? 0) + (pending.get(site) ?? 0);
  if (stored + bytes.byteLength > MAX_FILES_BYTES) {
    return refuse('SITE_FULL', ctx.id);
  }
  if ((usage?.files ?? 0) >= MAX_FILES) return refuse('SITE_FULL', ctx.id);

  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const release = reserve(site, bytes.byteLength);
  const target = join(filesDir(ctx.config.sitesDir, site), path);
  // The row goes first and is restored if the bytes fail. Bytes first would, on
  // a database error, leave the old etag and type describing the new bytes.
  try {
    await ctx.sql`
      insert into files (site, path, owner, size, type, sha256, updated_at)
      values (${site}, ${path}, ${existing?.owner ?? me.id}, ${bytes.byteLength},
              ${type}, ${sha256}, now())
      on conflict (site, path) do update
        set size = excluded.size, type = excluded.type,
            sha256 = excluded.sha256, updated_at = excluded.updated_at
    `;
    await write(ctx.config.sitesDir, site, target, bytes);
    await ctx.depot.put(objectName(site, path), bytes);
  } catch (cause) {
    await undo(ctx, site, path, existing, target);
    // A path that names a directory, or runs through a file, is the caller's
    // error: a 400 with no log line.
    if (COLLIDES.has(errno(cause))) return refuse('INVALID_PATH', ctx.id);
    logCause(ctx.id, `storing files/${site}/${path}`, cause);
    return refuse('STORAGE_FAILURE', ctx.id);
  } finally {
    release();
  }

  return ok(
    {
      path,
      url: fileUrl(ctx, site, path),
      size: bytes.byteLength,
      type,
    },
    ctx.id,
    existing === undefined ? 201 : 200,
  );
}

/** `write` fails with these when the path is already something else on disk. */
const COLLIDES: ReadonlySet<string> = new Set(['EISDIR', 'ENOTDIR', 'EEXIST']);

function errno(cause: unknown): string {
  return typeof cause === 'object' && cause !== null && 'code' in cause
    ? String((cause as { code: unknown }).code)
    : '';
}

async function undo(
  ctx: Ctx,
  site: string,
  path: string,
  existing: Existing | undefined,
  target: string,
): Promise<void> {
  await rm(target, { force: true }).catch(() => undefined);
  try {
    if (existing === undefined) {
      await ctx.sql`delete from files where site = ${site} and path = ${path}`;
      return;
    }
    await ctx.sql`
      update files set size = ${Number(existing.size)}, type = ${existing.type},
        sha256 = ${existing.sha256}, updated_at = ${existing.updated_at}
      where site = ${site} and path = ${path}
    `;
  } catch (cause) {
    logCause(ctx.id, `undoing files/${site}/${path}`, cause);
  }
}

/**
 * Temp file and rename, so a reader sees the old file or the new one. The temp
 * name starts with a dot, which no legal path segment can.
 */
async function write(
  sitesDir: string,
  site: string,
  target: string,
  bytes: Uint8Array,
): Promise<void> {
  const root = filesDir(sitesDir, site);
  await mkdir(dirname(target), { recursive: true, mode: 0o755 });
  const temp = join(root, `.tmp-${crypto.randomUUID()}`);
  try {
    await Bun.write(temp, bytes, { mode: 0o644 });
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
}

async function remove(
  ctx: Ctx,
  site: string,
  path: string,
  me: Me,
  owner: boolean,
): Promise<Response> {
  if (!legalPath(path)) return refuse('INVALID_PATH', ctx.id);
  return underLock(`${site}/${path}`, async () => {
    const [row] = (await ctx.sql`
      select owner from files where site = ${site} and path = ${path} limit 1
    `) as { owner: string }[];
    // Deleting a missing path succeeds.
    if (row === undefined) return empty(ctx.id);
    if (row.owner !== me.id && !owner) return refuse('FORBIDDEN', ctx.id);

    await ctx.sql`delete from files where site = ${site} and path = ${path}`;
    await rm(join(filesDir(ctx.config.sitesDir, site), path), {
      force: true,
    }).catch(() => undefined);
    await ctx.depot.delete(objectName(site, path)).catch((cause: unknown) => {
      // The row is gone, so a leftover object is never served.
      logCause(ctx.id, `deleting ${objectName(site, path)}`, cause);
    });
    return empty(ctx.id);
  });
}

/**
 * Public, with no cookie. Safety rests on `nosniff` and the stored type: the
 * allowlist refused documents, and anything not rendered is an attachment.
 */
export async function serveFile(
  request: Request,
  ctx: Ctx,
  site: string,
  path: string,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return refuse('METHOD_NOT_ALLOWED', ctx.id);
  }
  const file = path.slice('/files/'.length);
  // A path no upload could have taken is a plain 404.
  if (!legalPath(file)) return refuse('NOT_FOUND', ctx.id);

  const [row] = (await ctx.sql`
    select path, owner, size, type, sha256, updated_at from files
    where site = ${site} and path = ${file} limit 1
  `) as FileRow[];
  if (row === undefined) return refuse('NOT_FOUND', ctx.id);

  const etag = `"${row.sha256}"`;
  const headers: Record<string, string> = {
    etag,
    'content-type': row.type.startsWith('text/')
      ? `${row.type}; charset=utf-8`
      : row.type,
    'cache-control': 'public, max-age=60',
    'x-content-type-options': 'nosniff',
    'content-disposition': inline(row.type)
      ? 'inline'
      : `attachment; filename="${file.slice(file.lastIndexOf('/') + 1)}"`,
  };
  // ponytail: exact match only, as the static path does — a weak or
  // multi-valued `if-none-match` refetches the body.
  if (request.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers });
  }

  const root = filesDir(ctx.config.sitesDir, site);
  let onDisk = await fileAt(root, `/${file}`);
  if (onDisk === null) {
    const bytes = await ctx.depot.get(
      ctx.depot.locate(objectName(site, file)),
      MAX_FILE_BYTES,
    );
    // A row with no bytes anywhere is a lost file.
    if (bytes === null) {
      logCause(
        ctx.id,
        `rehydrating files/${site}/${file}`,
        'the depot has no object',
      );
      return refuse('NOT_FOUND', ctx.id);
    }
    const target = join(root, file);
    await write(ctx.config.sitesDir, site, target, bytes);
    onDisk = target;
  }

  const bytes = Bun.file(onDisk);
  if (request.method === 'HEAD') {
    return new Response(null, {
      headers: { ...headers, 'content-length': String(bytes.size) },
    });
  }
  return new Response(bytes, { headers });
}
