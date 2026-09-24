/**
 * Who is calling, decided once per request. The public host trusts nothing,
 * reaching the control host is the credential a claim needs, and the identity
 * host trusts a login header from its tailnet proxy.
 */
import type { Config } from './env.ts';
import { addressOf, prefix, trustedPeer } from './http.ts';

/** The host that answered, which decides what the request may assert. */
export type Door = 'public' | 'control' | 'identity';

export interface Caller {
  readonly door: Door;
  /**
   * Kept even when malformed: 401 means nothing was sent, 403 means what was
   * sent does not open this.
   */
  readonly authorization: string | null;
  readonly bearer: string | null;
  readonly login: string | null;
  /**
   * The rate-limit key: the login when there is one, else the address. They
   * never collide, because only a login has an `@`.
   */
  readonly bucket: string | null;
  /**
   * Both private hosts may claim and control sites. The public host may too
   * while no control host is set.
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
  // A client can write these headers itself, so they are read only on the
  // identity host from a peer in `KTHX_TAILNET_PROXIES`.
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

// No peer means a handler called directly from a test, the same rule
// `addressOf` uses. A running server always has a peer.
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
 * The caller's tailnet address, so two people on the tailnet get separate
 * buckets. The last entry: a Go reverse proxy appends to a client-written list.
 */
function forwardedFor(request: Request): string | null {
  const hops = request.headers.get('x-forwarded-for')?.split(',') ?? [];
  const nearest = hops.at(-1)?.trim();
  return nearest ? prefix(nearest) : null;
}

let warned = false;

/** Once per process, so the log is not flooded. */
function warnIgnored(peer: string): void {
  if (warned) return;
  warned = true;
  console.error(
    `identity headers from ${peer} ignored: not in KTHX_TAILNET_PROXIES`,
  );
}
