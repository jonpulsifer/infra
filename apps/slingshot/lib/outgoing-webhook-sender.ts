import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { checkRateLimit } from './rate-limit';
import { sanitizeHeaders } from './sanitize-headers';
import { validateOutgoingDomain } from './validate-outgoing-domain';

/**
 * Single choke point for every outbound HTTP request this app makes to a
 * user-supplied URL (webhook replay, ad-hoc "send test webhook", etc).
 *
 * This exists because `fetch()` follows redirects by default, and a domain
 * that passes `validateOutgoingDomain()` on the *initial* URL can still 302
 * to `http://169.254.169.254/` (cloud metadata), `http://127.0.0.1/`, or a
 * DNS name that resolves to a private IP (DNS rebinding). Every hop of a
 * redirect chain is re-validated here, both against the domain allowlist and
 * against the resolved IP address, so callers get real SSRF protection just
 * by going through `sendOutgoingWebhook()` instead of calling `fetch()`
 * themselves.
 */

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;
const METHODS_WITH_BODY = new Set(['POST', 'PUT', 'PATCH']);
// Redirect statuses that must preserve the original method + body (RFC 7231).
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
  /** Identifier passed to the rate limiter (e.g. project slug). Skipped if omitted. */
  rateLimitKey?: string;
}

// Private, link-local, loopback, and otherwise non-internet-routable ranges.
// Anything matching these is refused regardless of what validateOutgoingDomain
// allowed, because the allowlist only knows about hostnames, not the IP a
// hostname (or a redirect target) actually resolves to.
const blockedRanges = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (includes cloud metadata 169.254.169.254)
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
    // Unwrap IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) so they can't be
    // used to sneak a private IPv4 address past the ipv6 check.
    const mapped = address.match(
      /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i,
    );
    if (mapped) {
      return blockedRanges.check(mapped[1], 'ipv4');
    }
    return blockedRanges.check(address, 'ipv6');
  }
  // Not a parseable IP at all - fail closed.
  return true;
}

/**
 * Validate a URL against the domain allowlist AND resolve its hostname to
 * confirm it doesn't point at a private/internal address. Called once for
 * the initial URL and again on every redirect hop.
 */
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

/**
 * Headers must be ASCII - replace any non-ASCII characters (including
 * surrogate pairs) rather than letting `fetch()` throw or mangle them.
 */
function toAsciiHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const toAscii = (input: string) =>
    Array.from(input)
      .map((char) => {
        const code = char.charCodeAt(0);
        if (code >= 0xd800 && code <= 0xdfff) {
          return ''; // surrogate half - drop
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

/**
 * Send an HTTP request to a user-supplied URL with SSRF protection:
 * validates the domain allowlist and resolves+checks the IP before the
 * initial request, follows redirects manually (never delegating to
 * fetch's automatic redirect handling), and re-validates both the
 * allowlist and the resolved IP on every hop.
 *
 * Headers are ASCII-sanitized and then passed through `sanitizeHeaders()`
 * so known-sensitive header names (Authorization, provider tokens, etc.)
 * are redacted before anything leaves this server - this matters because
 * a "replay" of a captured incoming webhook could otherwise forward a
 * secret straight to an attacker-controlled destination.
 */
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
      // Best-effort drain so the connection can be released.
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
