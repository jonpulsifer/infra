import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { checkRateLimit } from './rate-limit';
import { sanitizeHeaders } from './sanitize-headers';
import { validateOutgoingDomain } from './validate-outgoing-domain';

// The one path for requests to user-supplied URLs. An allowed domain can
// redirect to a private address, so every hop is checked against the domain
// allowlist and the addresses its hostname resolves to.

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
// Only 307 and 308 must keep the method and body; other redirects continue
// as GET.
const REDIRECT_PRESERVES_METHOD = new Set([307, 308]);

export class OutgoingWebhookError extends Error {}

export interface OutgoingWebhookRequest {
  method: string;
  headers: Record<string, string>;
  body?: string | null;
}

export interface OutgoingWebhookResult {
  status: number;
  statusText: string;
  body: string;
  finalUrl: string;
  duration: number;
}

export interface SendOutgoingWebhookOptions {
  /** Rate limiter key, such as the project slug. Omitted means no limit. */
  rateLimitKey?: string;
}

// Refused whatever the domain allowlist says, since it checks hostnames and
// never the addresses they resolve to.
const blockedRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including cloud metadata
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved
] as const) {
  blockedRanges.addSubnet(net, prefix, 'ipv4');
}
for (const [net, prefix] of [
  ['::1', 128], // loopback
  ['::', 128], // unspecified
  ['fc00::', 7], // unique local addresses
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const) {
  blockedRanges.addSubnet(net, prefix, 'ipv6');
}

function isBlockedIp(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return blockedRanges.check(address, 'ipv4');
  }
  if (version === 6) {
    // Unwrapped so a mapped private IPv4 address cannot pass the IPv6 check.
    const mapped = address.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
    );
    if (mapped) {
      return blockedRanges.check(mapped[1], 'ipv4');
    }
    return blockedRanges.check(address, 'ipv6');
  }
  // Fail closed on anything that is not an IP.
  return true;
}

async function assertUrlIsSafe(url: string): Promise<URL> {
  const validation = validateOutgoingDomain(url);
  if (!validation.allowed) {
    throw new OutgoingWebhookError(validation.error || 'Domain not allowed');
  }

  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new OutgoingWebhookError(`Unsupported protocol: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  if (isIP(hostname)) {
    if (isBlockedIp(hostname)) {
      throw new OutgoingWebhookError(
        `Refusing to send to private/internal address ${hostname}`,
      );
    }
    return parsed;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new OutgoingWebhookError(`Could not resolve host ${hostname}`);
  }

  if (resolved.length === 0) {
    throw new OutgoingWebhookError(`Could not resolve host ${hostname}`);
  }

  for (const { address } of resolved) {
    if (isBlockedIp(address)) {
      throw new OutgoingWebhookError(
        `Refusing to send to private/internal address ${address} (resolved from ${hostname})`,
      );
    }
  }

  return parsed;
}

// fetch() throws on a header character above U+00FF.
function toAsciiHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const toAscii = (input: string) =>
    Array.from(input)
      .map((char) => {
        const code = char.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) {
          return ''; // a non-BMP character or a lone surrogate
        }
        return code > 255 ? '?' : char;
      })
      .join('');

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const asciiKey = toAscii(key).trim();
    if (asciiKey) {
      result[asciiKey] = toAscii(value);
    }
  }
  return result;
}

export async function sendOutgoingWebhook(
  url: string,
  request: OutgoingWebhookRequest,
  options: SendOutgoingWebhookOptions = {},
): Promise<OutgoingWebhookResult> {
  if (options.rateLimitKey) {
    const rateLimit = checkRateLimit(options.rateLimitKey);
    if (!rateLimit.success) {
      throw new OutgoingWebhookError(
        'Rate limit exceeded for outgoing webhooks. Please try again shortly.',
      );
    }
  }

  // Redacted so replaying a captured webhook cannot forward its secrets.
  const sendHeaders = sanitizeHeaders(toAsciiHeaders(request.headers || {}));

  let currentUrl = await assertUrlIsSafe(url);
  let currentMethod = request.method;
  let currentBody = request.body;

  const startTime = Date.now();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const hasBody =
      !!currentBody && METHODS_WITH_BODY.has(currentMethod.toUpperCase());

    const response = await fetch(currentUrl.toString(), {
      method: currentMethod,
      headers: sendHeaders,
      body: hasBody ? currentBody : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const isRedirect = response.status >= 300 && response.status < 400;
    const location = response.headers.get('location');

    if (isRedirect && location) {
      // Cancelled so the connection is released.
      response.body?.cancel().catch(() => {});

      if (hop === MAX_REDIRECTS) {
        throw new OutgoingWebhookError(
          `Too many redirects (max ${MAX_REDIRECTS})`,
        );
      }

      const nextUrl = new URL(location, currentUrl);
      currentUrl = await assertUrlIsSafe(nextUrl.toString());

      if (!REDIRECT_PRESERVES_METHOD.has(response.status)) {
        currentMethod = 'GET';
        currentBody = null;
      }
      continue;
    }

    const responseText = await response.text();
    return {
      status: response.status,
      statusText: response.statusText,
      body: responseText,
      finalUrl: currentUrl.toString(),
      duration: Date.now() - startTime,
    };
  }

  throw new OutgoingWebhookError(`Too many redirects (max ${MAX_REDIRECTS})`);
}
