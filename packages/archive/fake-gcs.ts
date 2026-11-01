/**
 * A Cloud Storage JSON API that is not Cloud Storage: the subset {@link gcs.ts}
 * speaks, in memory, on a local port. Tests point a client at it with
 * `endpoint` or `STORAGE_EMULATOR_HOST`.
 */
import { crc32c } from './crc32c.ts';

export interface FakeObject {
  readonly bytes: Uint8Array;
  readonly generation: number;
  readonly metageneration: number;
  readonly contentType: string;
  readonly cacheControl: string | null;
  readonly metadata: Record<string, string>;
  readonly timeCreated: string;
  readonly updated: string;
}

export interface FakeCall {
  readonly method: string;
  /** `list`, `stat`, `read`, `write`, `patch` or `delete`. */
  readonly kind: string;
  readonly bucket: string;
  /** The object name, or the list prefix. */
  readonly name: string;
  readonly ifGenerationMatch: string | null;
}

export interface FakeGcs {
  readonly url: string;
  readonly calls: FakeCall[];
  /** bucket → name → object */
  readonly buckets: Map<string, Map<string, FakeObject>>;
  /** Runs before a request is answered; a test can race a write in here. */
  before: ((call: FakeCall) => void | Promise<void>) | null;
  /** Answers a call with this status instead, once per entry. */
  readonly failures: { match: (call: FakeCall) => boolean; status: number }[];
  put(
    bucket: string,
    name: string,
    body: string | Uint8Array,
    options?: {
      contentType?: string;
      metadata?: Record<string, string>;
      cacheControl?: string;
    },
  ): FakeObject;
  get(bucket: string, name: string): FakeObject | undefined;
  names(bucket: string, prefix?: string): string[];
  text(bucket: string, name: string): string | undefined;
  stop(): void;
}

function globRegex(glob: string): RegExp {
  let pattern = '';
  for (let at = 0; at < glob.length; at += 1) {
    const char = glob[at] ?? '';
    if (char === '*' && glob[at + 1] === '*') {
      pattern += '.*';
      at += 1;
    } else if (char === '*') {
      pattern += '[^/]*';
    } else if (char === '?') {
      pattern += '[^/]';
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function fakeGcs(): FakeGcs {
  const buckets = new Map<string, Map<string, FakeObject>>();
  const calls: FakeCall[] = [];
  let generation = 1_700_000_000_000_000;

  const bucketOf = (name: string) => {
    let found = buckets.get(name);
    if (found === undefined) {
      found = new Map();
      buckets.set(name, found);
    }
    return found;
  };

  const store = (
    bucket: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
    cacheControl: string | null,
    metadata: Record<string, string>,
  ): FakeObject => {
    generation += 1;
    const now = new Date().toISOString();
    const object: FakeObject = {
      bytes,
      generation,
      metageneration: 1,
      contentType,
      cacheControl,
      metadata,
      timeCreated: now,
      updated: now,
    };
    bucketOf(bucket).set(name, object);
    return object;
  };

  const resource = (bucket: string, name: string, object: FakeObject) => ({
    kind: 'storage#object',
    bucket,
    name,
    generation: String(object.generation),
    metageneration: String(object.metageneration),
    size: String(object.bytes.byteLength),
    contentType: object.contentType,
    ...(object.cacheControl === null
      ? {}
      : { cacheControl: object.cacheControl }),
    crc32c: crc32c(object.bytes),
    md5Hash: new Bun.CryptoHasher('md5').update(object.bytes).digest('base64'),
    metadata: object.metadata,
    timeCreated: object.timeCreated,
    updated: object.updated,
  });

  const problem = (status: number, message: string) =>
    Response.json({ error: { code: status, message } }, { status });

  const fake: FakeGcs = {
    url: '',
    calls,
    buckets,
    before: null,
    failures: [],
    put(bucket, name, body, options = {}) {
      const bytes =
        typeof body === 'string' ? new TextEncoder().encode(body) : body;
      return store(
        bucket,
        name,
        bytes,
        options.contentType ?? 'application/octet-stream',
        options.cacheControl ?? null,
        options.metadata ?? {},
      );
    },
    get: (bucket, name) => buckets.get(bucket)?.get(name),
    names: (bucket, prefix = '') =>
      [...(buckets.get(bucket)?.keys() ?? [])]
        .filter((name) => name.startsWith(prefix))
        .sort(),
    text(bucket, name) {
      const object = buckets.get(bucket)?.get(name);
      return object === undefined
        ? undefined
        : new TextDecoder().decode(object.bytes);
    },
    stop: () => server.stop(true),
  };

  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (!request.headers.get('authorization')?.startsWith('Bearer ')) {
        return problem(401, 'no bearer');
      }
      const url = new URL(request.url);
      const query = url.searchParams;
      const upload = /^\/upload\/storage\/v1\/b\/([^/]+)\/o$/.exec(
        url.pathname,
      );
      const list = /^\/storage\/v1\/b\/([^/]+)\/o$/.exec(url.pathname);
      const one = /^\/storage\/v1\/b\/([^/]+)\/o\/([^/]+)$/.exec(url.pathname);
      const precondition = query.get('ifGenerationMatch');

      let call: FakeCall;
      let bucket: string;
      if (upload !== null) {
        bucket = decodeURIComponent(upload[1] ?? '');
        call = {
          method: request.method,
          kind: 'write',
          bucket,
          name: query.get('name') ?? '',
          ifGenerationMatch: precondition,
        };
      } else if (list !== null) {
        bucket = decodeURIComponent(list[1] ?? '');
        call = {
          method: request.method,
          kind: 'list',
          bucket,
          name: query.get('prefix') ?? '',
          ifGenerationMatch: null,
        };
      } else if (one !== null) {
        bucket = decodeURIComponent(one[1] ?? '');
        const kind =
          request.method === 'DELETE'
            ? 'delete'
            : request.method === 'PATCH'
              ? 'patch'
              : query.get('alt') === 'media'
                ? 'read'
                : 'stat';
        call = {
          method: request.method,
          kind,
          bucket,
          name: decodeURIComponent(one[2] ?? ''),
          ifGenerationMatch: precondition,
        };
      } else {
        return problem(404, `no route ${url.pathname}`);
      }

      // A multipart write names its object in the body, read below; the hook
      // and the recorded call see that name.
      let parsed: {
        resource: Record<string, unknown>;
        bytes: Uint8Array;
      } | null = null;
      if (call.kind === 'write') {
        const raw = new Uint8Array(await request.arrayBuffer());
        if (query.get('uploadType') === 'multipart') {
          parsed = multipart(raw, request.headers.get('content-type') ?? '');
          if (parsed === null) return problem(400, 'unreadable multipart');
          call = { ...call, name: String(parsed.resource.name ?? '') };
        } else {
          parsed = {
            resource: {
              name: call.name,
              contentType:
                request.headers.get('content-type') ??
                'application/octet-stream',
            },
            bytes: raw,
          };
        }
      }

      calls.push(call);
      await fake.before?.(call);
      const failure = fake.failures.findIndex((entry) => entry.match(call));
      if (failure !== -1) {
        const [entry] = fake.failures.splice(failure, 1);
        return problem(entry?.status ?? 500, 'injected failure');
      }

      const objects = bucketOf(bucket);
      const existing = objects.get(call.name);
      const holds =
        precondition === null ||
        (precondition === '0'
          ? existing === undefined
          : existing !== undefined &&
            String(existing.generation) === precondition);

      switch (call.kind) {
        case 'list': {
          const glob = query.get('matchGlob');
          const matcher = glob === null ? null : globRegex(glob);
          const names = [...objects.keys()]
            .filter((name) => name.startsWith(call.name))
            .filter((name) => matcher === null || matcher.test(name))
            .sort();
          const size = Number(query.get('maxResults') ?? 1000);
          const start = Number(query.get('pageToken') ?? 0);
          const page = names.slice(start, start + size);
          const next =
            start + size < names.length ? String(start + size) : null;
          return Response.json({
            kind: 'storage#objects',
            items: page.map((name) =>
              resource(bucket, name, objects.get(name) as FakeObject),
            ),
            ...(next === null ? {} : { nextPageToken: next }),
          });
        }
        case 'stat':
          return existing === undefined
            ? problem(404, 'No such object')
            : Response.json(resource(bucket, call.name, existing));
        case 'read':
          return existing === undefined
            ? problem(404, 'No such object')
            : new Response(existing.bytes as unknown as BodyInit, {
                headers: {
                  'content-type': existing.contentType,
                  'content-length': String(existing.bytes.byteLength),
                },
              });
        case 'write': {
          if (!holds) return problem(412, 'Precondition Failed');
          const written = parsed as {
            resource: Record<string, unknown>;
            bytes: Uint8Array;
          };
          const metadata: Record<string, string> = {};
          const declared = written.resource.metadata;
          if (typeof declared === 'object' && declared !== null) {
            for (const [key, value] of Object.entries(declared)) {
              metadata[key] = String(value);
            }
          }
          const object = store(
            bucket,
            call.name,
            written.bytes,
            String(written.resource.contentType ?? 'application/octet-stream'),
            typeof written.resource.cacheControl === 'string'
              ? written.resource.cacheControl
              : null,
            metadata,
          );
          return Response.json(resource(bucket, call.name, object));
        }
        case 'patch': {
          if (existing === undefined) return problem(404, 'No such object');
          if (!holds) return problem(412, 'Precondition Failed');
          const body = (await request.json()) as {
            metadata?: Record<string, string | null>;
          };
          const metadata = { ...existing.metadata };
          for (const [key, value] of Object.entries(body.metadata ?? {})) {
            if (value === null) delete metadata[key];
            else metadata[key] = value;
          }
          const object: FakeObject = {
            ...existing,
            metadata,
            metageneration: existing.metageneration + 1,
            updated: new Date().toISOString(),
          };
          objects.set(call.name, object);
          return Response.json(resource(bucket, call.name, object));
        }
        case 'delete':
          if (existing === undefined) return problem(404, 'No such object');
          if (!holds) return problem(412, 'Precondition Failed');
          objects.delete(call.name);
          return new Response(null, { status: 204 });
        default:
          return problem(400, 'unknown call');
      }
    },
  });

  (fake as { url: string }).url = `http://127.0.0.1:${server.port}`;
  return fake;
}

/** The JSON part and the media part of a `multipart/related` upload. */
function multipart(
  raw: Uint8Array,
  type: string,
): { resource: Record<string, unknown>; bytes: Uint8Array } | null {
  const boundary = /boundary=([^;]+)/.exec(type)?.[1]?.trim();
  if (boundary === undefined) return null;
  const text = Buffer.from(raw).toString('latin1');
  const parts = text.split(`--${boundary}`).slice(1, -1);
  const bodies = parts.map((part) => {
    const split = part.indexOf('\r\n\r\n');
    return part.slice(split + 4, part.length - 2);
  });
  const [json, media] = bodies;
  if (json === undefined || media === undefined) return null;
  try {
    return {
      resource: JSON.parse(Buffer.from(json, 'latin1').toString('utf8')),
      bytes: new Uint8Array(Buffer.from(media, 'latin1')),
    };
  } catch {
    return null;
  }
}
