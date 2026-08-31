/**
 * The shape every refusal takes, and the three facts every handler needs from
 * a request: which host, which id, and whether the caller is same-origin.
 *
 * One fixed sentence per code, from the contract's error table. Fixed because
 * the cause is not the caller's to read: an upload that fails because the depot
 * answered 403 and one that fails because the disk is full are both
 * `STORAGE_FAILURE` on the wire, and the difference goes to the log under the
 * `x-request-id` the caller was handed. An `x-filename` a caller sent is never
 * echoed anywhere.
 */
import { timingSafeEqual } from 'node:crypto';

/** The codes this process answers with. Later tickets add their own rows. */
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
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'TIMEOUT'
  | 'TAKEN'
  | 'EXISTS'
  | 'OWNED'
  | 'GONE'
  | 'PRECONDITION_FAILED'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'AI_BUDGET'
  | 'STORAGE_FAILURE'
  | 'AI_UPSTREAM'
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
    'this needs a google identity: Authorization: Bearer $(gcloud auth print-identity-token), or run kthx',
  ],
  FORBIDDEN: [403, 'that does not open this site'],
  NOT_FOUND: [404, 'there is nothing here'],
  METHOD_NOT_ALLOWED: [405, 'that is not something this path does'],
  TIMEOUT: [408, 'the body was not sent within the time this path waits'],
  TAKEN: [409, 'that name is taken'],
  EXISTS: [409, 'that id is already in this collection'],
  OWNED: [409, 'that site already has an owner'],
  GONE: [410, 'that site is gone'],
  PRECONDITION_FAILED: [412, 'it changed since it was read'],
  TOO_LARGE: [413, 'that is larger than this path accepts'],
  RATE_LIMITED: [429, 'too many requests; wait'],
  AI_BUDGET: [429, "this site has spent today's ai budget"],
  STORAGE_FAILURE: [500, 'storing the release failed'],
  AI_UPSTREAM: [502, 'the ai upstream did not answer'],
  BUSY: [503, 'the server is full right now; try again in a moment'],
  SITE_FULL: [507, 'this site is full; delete something to add something'],
};

/**
 * Two strings compared without leaking how far they match.
 *
 * Both a cookie's HMAC and a bearer's hash are checked this way, so the
 * comparison lives here rather than once per caller.
 */
export function timingSafeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Never absent: a caller with no cause to read still gets one to quote. */
export function requestId(): string {
  return crypto.randomUUID();
}

const BASE_HEADERS = { 'x-content-type-options': 'nosniff' } as const;

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
 * The whole body, `null` once it goes past `maxBytes`, or a rejection once the
 * deadline passes.
 *
 * `fetch` has no deadline of its own, so a caller that opens a `PUT` and then
 * sends a byte a minute holds a slot — an unpack slot for a release, one of the
 * eight file writes — for as long as the kernel keeps the socket.
 *
 * Read a chunk at a time and cancelled the moment it goes over, because
 * `content-length` is absent on a chunked body and the server-wide ceiling is
 * 32 MiB: materialising first would let every caller pin more than its own
 * route allows, times however many the route runs at once.
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

/** What the caller is told nothing about, written where an operator can find it. */
export function logCause(id: string, what: string, cause: unknown): void {
  console.error(
    `[${id}] ${what}: ${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}`,
  );
}

// --- the host ---------------------------------------------------------------

/** Lowercased, trailing dot and port stripped — the only name a site has. */
export function hostOf(request: Request): string {
  return (request.headers.get('host') ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

/**
 * The kthx name this host is: `''` for the apex, the label for a site, `null`
 * for a host outside the zone.
 *
 * A deeper label (`a.b.<zone>`) comes back as `a.b`, which no row can match and
 * which therefore answers the 404 page rather than leaking that the zone has a
 * wildcard behind it.
 */
export function siteOf(host: string, zone: string): string | null {
  if (host === zone) return '';
  if (!host.endsWith(`.${zone}`)) return null;
  return host.slice(0, -zone.length - 1);
}

/**
 * `https://<label>.<zone>` — or plain http on the port a local run listens on,
 * because nothing terminates TLS in front of `kthx.localhost` and a URL a
 * developer cannot open is not a URL.
 */
export function siteUrl(zone: string, label?: string, port?: string): string {
  const host = label === undefined ? zone : `${label}.${zone}`;
  if (!zone.endsWith('.localhost')) return `https://${host}`;
  return `http://${host}${port ? `:${port}` : ''}`;
}

/** The port the request named, for the URL a local run hands back. */
export function portOf(request: Request): string {
  return /:(\d+)$/.exec(request.headers.get('host')?.trim() ?? '')?.[1] ?? '';
}

/**
 * The same-site guard.
 *
 * `kthx.dev` is not on the Public Suffix List, so a browser treats every
 * `*.kthx.dev` as one site and `SameSite=Lax` protects nothing between
 * siblings. A non-browser client sends no `Origin` at all and is let through;
 * a browser must be on this exact host.
 */
export function sameOrigin(request: Request, host: string, port = ''): boolean {
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  // With the port, because an `Origin` carries one whenever the browser is on
  // a non-default port and a local run is the whole reason that happens.
  const authority = port === '' ? host : `${host}:${port}`;
  return origin === `https://${authority}` || origin === `http://${authority}`;
}

/** JSON routes take JSON, parameters ignored. */
export function isJson(request: Request): boolean {
  const type = request.headers.get('content-type') ?? '';
  return type.split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * The address a bucket is keyed by, IPv6 truncated to its /64.
 *
 * `cf-connecting-ip` is a header, so it is worth exactly as much as the peer
 * that sent it: the Gateway is reachable on the LAN and the tailnet as well as
 * through cloudflared, and a client that arrives that way would otherwise
 * rotate one header and defeat every address-keyed bucket. It is honoured only
 * from a peer in `KTHX_TRUSTED_PROXIES`, or when there is no socket peer at all
 * (a handler called directly, which is a test and not a network).
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

/**
 * Whether this request arrived from a peer this deployment believes.
 *
 * The same rule {@link addressOf} uses, and for the same reason: a header is
 * worth what the peer that sent it is worth. No socket peer at all is a handler
 * called directly, which is a test and not a network.
 */
export function fromTrustedProxy(
  request: Request,
  server: Bun.Server<unknown> | undefined,
  trusted: readonly string[],
): boolean {
  const peer = server?.requestIP(request)?.address?.trim() ?? null;
  return peer === null || trustedPeer(peer, trusted);
}

let warned = false;

/** Once per process: a line an operator can find, not one per request. */
function warnIgnored(peer: string): void {
  if (warned) return;
  warned = true;
  console.error(
    `cf-connecting-ip from ${peer} ignored: not in KTHX_TRUSTED_PROXIES`,
  );
}

/**
 * The /64 an address belongs to, which is what one residential customer gets
 * and therefore what a bucket has to be keyed by. IPv4 keys by itself.
 */
export function prefix(raw: string): string {
  const address = (raw.split('%')[0] ?? raw).trim().toLowerCase();
  // No colon is IPv4; a dot inside a colon form is a v4-mapped address, whose
  // /64 is meaningless — key it whole.
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

/**
 * Whether this socket peer may speak for someone else.
 *
 * ponytail: IPv4 CIDRs and exact addresses. The Gateway and cloudflared are
 * IPv4 in this cluster, so a prefix is only ever needed for v4; an IPv6 entry
 * has to be written out in full. Widen the day the pod network is dual-stack.
 */
function trustedPeer(peer: string, trusted: readonly string[]): boolean {
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
