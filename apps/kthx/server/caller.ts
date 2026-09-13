/**
 * Who is calling, decided once per request.
 *
 * Three hosts answer this process and they believe three different things: the
 * public zone believes nothing, the control host believes reach (getting to it
 * is the credential a claim needs), and the identity host believes a header a
 * tailnet proxy set. Before this existed each of those facts was re-derived
 * where it was needed — a `===` against one hostname in the dispatcher, five
 * separate `addressOf` calls, an `Authorization` regex in two files — and a
 * route that forgot one of them was a route that quietly answered as somebody
 * else.
 *
 * The header is worth exactly as much as the peer that sent it, so it is read
 * only on the identity host and only from a peer in `KTHX_TAILNET_PROXIES` —
 * which is empty unless a deployment says otherwise, and which is deliberately
 * not `KTHX_TRUSTED_PROXIES`: that one is the whole pod CIDR.
 */
import type { Config } from './env.ts';
import { addressOf, prefix, trustedPeer } from './http.ts';

/** Which host answered, which is what decides what may be believed. */
export type Door = 'public' | 'control' | 'identity';

export interface Caller {
  readonly door: Door;
  /**
   * The `Authorization` header as sent, so a malformed one is still a
   * credential that was offered: 401 is "you sent nothing", 403 is "what you
   * sent does not open this".
   */
  readonly authorization: string | null;
  /** The bearer inside it, when it is one. */
  readonly bearer: string | null;
  /** The tailnet login the identity proxy vouched for, or `null`. */
  readonly login: string | null;
  /**
   * What every address-keyed bucket is keyed by: the login where there is one
   * — an allowance per human rather than per host — else the address.
   *
   * An address and a login can never collide: one has an `@`, the other is
   * digits, dots and colons.
   */
  readonly bucket: string | null;
  /**
   * Whether this door may claim and control sites: both private hosts, and the
   * apex only while neither is configured.
   */
  readonly control: boolean;
}

const BEARER = /^Bearer\s+(\S+)$/i;

export function callerOf(
  request: Request,
  server: Bun.Server<unknown> | undefined,
  config: Config,
  host: string,
): Caller {
  const door: Door =
    config.identityHost !== null && host === config.identityHost
      ? 'identity'
      : config.controlHost !== null && host === config.controlHost
        ? 'control'
        : 'public';
  const authorization = request.headers.get('authorization');
  // A peer that may not speak for anyone else leaves both of the identity
  // door's facts unread — the login and the caller's own tailnet address —
  // because they arrive in the same two headers a client could write itself.
  const vouched = door === 'identity' && trustedHop(request, server, config);
  const login = vouched
    ? request.headers.get(config.identityHeader)?.trim().toLowerCase() || null
    : null;
  const forwarded = vouched ? forwardedFor(request) : null;
  return {
    door,
    authorization,
    bearer: BEARER.exec(authorization ?? '')?.[1] ?? null,
    login,
    bucket:
      login ?? forwarded ?? addressOf(request, server, config.trustedProxies),
    control: door !== 'public' || config.controlHost === null,
  };
}

/**
 * Whether this socket peer is the identity proxy.
 *
 * No peer at all is a handler called directly, which is a test and not a
 * network — the same rule `addressOf` reads `cf-connecting-ip` under. In a
 * running process there is always a peer, so an empty `KTHX_TAILNET_PROXIES`
 * believes nobody.
 */
function trustedHop(
  request: Request,
  server: Bun.Server<unknown> | undefined,
  config: Config,
): boolean {
  const peer = server?.requestIP(request)?.address?.trim() ?? null;
  if (peer === null || peer === '') return true;
  if (trustedPeer(peer, config.tailnetProxies)) return true;
  warnIgnored(peer);
  return false;
}

/**
 * The caller's own tailnet address, as the proxy observed it.
 *
 * `addressOf` discards this header, and rightly so everywhere else: on the
 * Cloudflare path it is a header anyone may write, and honouring it would turn
 * every address-keyed bucket into one line of a request. Here it is the only
 * thing that tells two people on the tailnet apart, and without it they would
 * share one bucket — twenty claims a day between a household.
 *
 * The **last** entry, not the first. A Go reverse proxy appends rather than
 * replaces, so a client that writes its own `x-forwarded-for` puts a value of
 * its choosing at the head of the list; the tail is the one hop that is
 * trusted here, and it is the only entry that hop wrote itself.
 */
function forwardedFor(request: Request): string | null {
  const hops = request.headers.get('x-forwarded-for')?.split(',') ?? [];
  const nearest = hops.at(-1)?.trim();
  return nearest ? prefix(nearest) : null;
}

let warned = false;

/** Once per process: a line an operator can find, not one per request. */
function warnIgnored(peer: string): void {
  if (warned) return;
  warned = true;
  console.error(
    `identity headers from ${peer} ignored: not in KTHX_TAILNET_PROXIES`,
  );
}
