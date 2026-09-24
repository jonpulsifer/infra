/**
 * Refusals and the request facts every handler reads. Each code has one fixed
 * message; the cause goes only to the log, under the caller's `x-request-id`.
 */
import { timingSafeEqual } from 'node:crypto';

export type Code =
  | 'INVALID_NAME'
  | 'RESERVED'
  | 'UNKNOWN_FORMAT'
  | 'UNSUPPORTED_ZIP'
  | 'MALFORMED_ZIP'
  | 'PATH_ESCAPES_ARCHIVE'
  | 'NO_INDEX'
  | 'INVALID_COLLECTION'
  | 'INVALID_ID'
  | 'INVALID_DOCUMENT'
  | 'INVALID_QUERY'
  | 'INVALID_PATH'
  | 'UNSUPPORTED_TYPE'
  | 'INVALID_MODEL'
  | 'MALFORMED_REQUEST'
  | 'UNAUTHENTICATED'
  | 'FORBIDDEN'
  | 'PRIVATE'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'TAKEN'
  | 'EXISTS'
  | 'GONE'
  | 'PRECONDITION_FAILED'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'AI_BUDGET'
  | 'STORAGE_FAILURE'
  | 'AI_UPSTREAM'
  | 'NO_DOCUMENT'
  | 'BUSY'
  | 'SITE_FULL';

const ERRORS: Record<Code, readonly [number, string]> = {
  INVALID_NAME: [
    400,
    'a name is 3 to 40 of a-z, 0-9 and -, and does not start or end with -',
  ],
  RESERVED: [400, 'that name is reserved'],
  UNKNOWN_FORMAT: [400, 'the upload is neither a gzipped tar nor a ZIP'],
  UNSUPPORTED_ZIP: [
    400,
    'this ZIP uses a feature the upload boundary does not read',
  ],
  MALFORMED_ZIP: [400, 'the archive could not be read'],
  PATH_ESCAPES_ARCHIVE: [400, 'the archive names a path outside itself'],
  NO_INDEX: [400, 'the archive has no index.html or 200.html at its root'],
  INVALID_COLLECTION: [400, 'a collection is 1 to 64 of a-z, 0-9, - and _'],
  INVALID_ID: [400, 'an id is 1 to 128 of A-Z, a-z, 0-9, - and _'],
  INVALID_DOCUMENT: [
    400,
    'a document is a JSON object, at most 32 deep, without NUL',
  ],
  INVALID_QUERY: [400, 'that is not a query this collection takes'],
  INVALID_PATH: [
    400,
    'a file path is up to 256 of A-Z, a-z, 0-9, ., _, - and /, and no segment starts with a dot',
  ],
  UNSUPPORTED_TYPE: [
    400,
    'files take image, audio, video, application/pdf, application/json, text/plain, text/csv and text/markdown',
  ],
  INVALID_MODEL: [400, 'that model is not one this site may ask for'],
  MALFORMED_REQUEST: [
    400,
    'the request body or content type is not what this path takes',
  ],
  UNAUTHENTICATED: [
    401,
    'this site is opened with its token: Authorization: Bearer <token>',
  ],
  FORBIDDEN: [403, 'that does not open this site'],
  PRIVATE: [
    403,
    'claiming and site control answer on the private host only; point KTHX_ORIGIN at it',
  ],
  NOT_FOUND: [404, 'there is nothing here'],
  METHOD_NOT_ALLOWED: [405, 'that is not something this path does'],
  TIMEOUT: [408, 'the body was not sent within the time this path waits'],
  TAKEN: [409, 'that name is taken'],
  EXISTS: [409, 'that id is already in this collection'],
  GONE: [410, 'that site is gone'],
  PRECONDITION_FAILED: [412, 'it changed since it was read'],
  TOO_LARGE: [413, 'that is larger than this path accepts'],
  RATE_LIMITED: [429, 'too many requests; wait'],
  AI_BUDGET: [429, "this site has spent today's ai budget"],
  STORAGE_FAILURE: [500, 'storing the release failed'],
  AI_UPSTREAM: [502, 'the ai upstream did not answer'],
  NO_DOCUMENT: [502, 'the answer came back without a web page in it'],
  BUSY: [503, 'the server is full right now; try again in a moment'],
  SITE_FULL: [507, 'this site is full; delete something to add something'],
};

export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requestId(): string {
  return crypto.randomUUID();
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

/** The {@link refuse} body, for a stream whose status is already 200. */
export function problem(code: Code): { code: Code; message: string } {
  return { code, message: ERRORS[code][1] };
}

export function refuse(
  code: Code,
  id: string,
  extra: Record<string, string> = {},
): Response {
  const [status, message] = ERRORS[code];
  return Response.json(
    { code, message },
    {
      status,
      headers: {
        ...BASE_HEADERS,
        ...extra,
        'x-request-id': id,
        'cache-control': 'no-store',
      },
    },
  );
}

export function ok(
  body: unknown,
  id: string,
  status = 200,
  cacheControl = 'no-store',
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: {
      ...BASE_HEADERS,
      ...extra,
      'x-request-id': id,
      'cache-control': cacheControl,
    },
  });
}

export function empty(id: string): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...BASE_HEADERS,
      'x-request-id': id,
      'cache-control': 'no-store',
    },
  });
}

/**
 * `null` past `maxBytes`; rejects after `ms`, so a slow sender cannot hold a
 * slot. Read in chunks, because a chunked body has no `content-length`.
 */
export async function bodyWithin(
  request: Request,
  ms: number,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('the body did not arrive in time')),
      ms,
    );
  });
  const parts: Uint8Array[] = [];
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), expired]);
      if (done === true || value === undefined) break;
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    clearTimeout(timer);
  }
  return Buffer.concat(parts);
}

/** Logs the cause a refusal hides from the caller. */
export function logCause(id: string, what: string, cause: unknown): void {
  console.error(
    `[${id}] ${what}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
  );
}

export function hostOf(request: Request): string {
  return (request.headers.get('host') ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * `''` for the apex, the label for a site, `null` outside the zone. A deeper
 * host `a.b.<zone>` returns `a.b`, which matches no site and gets the 404 page.
 */
export function siteOf(host: string, zone: string): string | null {
  if (host === zone) return '';
  if (!host.endsWith(`.${zone}`)) return null;
  return host.slice(0, -zone.length - 1);
}

/** Plain http and the port for a `.localhost` zone, which has no TLS. */
export function siteUrl(zone: string, label?: string, port?: string): string {
  const host = label === undefined ? zone : `${label}.${zone}`;
  if (!zone.endsWith('.localhost')) return `https://${host}`;
  return `http://${host}${port ? `:${port}` : ''}`;
}

export function portOf(request: Request): string {
  return /:(\d+)$/.exec(request.headers.get('host')?.trim() ?? '')?.[1] ?? '';
}

/**
 * `kthx.dev` is not on the Public Suffix List, so `SameSite=Lax` does not
 * separate sibling sites. A request with no `Origin` passes; a browser must be
 * on this exact host.
 */
export function sameOrigin(request: Request, host: string, port = ''): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  // An `Origin` carries the port when it is non-default, as in a local run.
  const authority = port === '' ? host : `${host}:${port}`;
  return origin === `https://${authority}` || origin === `http://${authority}`;
}

export function isJson(request: Request): boolean {
  const type = request.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * The Gateway is reachable around cloudflared, so `cf-connecting-ip` is read
 * only from a peer in `KTHX_TRUSTED_PROXIES`, or with no peer (a test).
 */
export function addressOf(
  request: Request,
  server: Bun.Server<unknown> | undefined,
  trusted: readonly string[] = [],
): string | null {
  const peer = server?.requestIP(request)?.address?.trim() ?? null;
  const forwarded = request.headers.get('cf-connecting-ip')?.trim() || null;
  if (forwarded !== null && (peer === null || trustedPeer(peer, trusted))) {
    return prefix(forwarded);
  }
  if (forwarded !== null) warnIgnored(peer ?? 'an unknown peer');
  return peer === null || peer === '' ? null : prefix(peer);
}

let warned = false;

/** Once per process, so the log is not flooded. */
function warnIgnored(peer: string): void {
  if (warned) return;
  warned = true;
  console.error(
    `cf-connecting-ip from ${peer} ignored: not in KTHX_TRUSTED_PROXIES`,
  );
}

/** IPv6 is keyed by its /64, the block one residential customer gets. */
export function prefix(raw: string): string {
  const address = (raw.split('%')[0] ?? raw).trim().toLowerCase();
  // A v4-mapped address has a dot and no meaningful /64, so it is kept whole.
  if (!address.includes(':') || address.includes('.')) return address;
  const [head = '', tail] = address.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined || tail === '' ? [] : tail.split(':');
  const groups = address.includes('::')
    ? [
        ...left,
        ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'),
        ...right,
      ]
    : left;
  return groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ''))
    .join(':');
}

// ponytail: CIDRs are IPv4 only and an IPv6 entry must match exactly; widen
// when the pod network goes dual-stack.
export function trustedPeer(peer: string, trusted: readonly string[]): boolean {
  const address = peer.startsWith('::ffff:') ? peer.slice(7) : peer;
  return trusted.some((entry) => {
    const [network = '', bits] = entry.split('/');
    if (bits === undefined) return network === address;
    const width = Number(bits);
    const left = v4(network);
    const right = v4(address);
    if (left === null || right === null) return false;
    if (!Number.isInteger(width) || width < 0 || width > 32) return false;
    const mask = width === 0 ? 0 : (-1 << (32 - width)) >>> 0;
    return (left & mask) >>> 0 === (right & mask) >>> 0;
  });
}

function v4(raw: string): number | null {
  const parts = raw.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const byte = Number(part);
    if (part === '' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
      return null;
    }
    value = value * 256 + byte;
  }
  return value;
}
