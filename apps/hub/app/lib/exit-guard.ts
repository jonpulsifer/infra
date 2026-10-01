import { BlockList, isIP } from 'node:net';

// LAN, tailnet and loopback. A public address is never in these ranges.
const DEFAULT_ALLOWED = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '::1/128',
  'fc00::/7',
];

function buildList(cidrs: string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, prefix] = cidr.trim().split('/');
    const family = isIP(address);
    if (!family || !prefix) continue;
    list.addSubnet(address, Number(prefix), family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

// Envoy appends the address it saw to X-Forwarded-For, so the last entry is
// the peer the gateway accepted. Earlier entries are caller-supplied.
export function clientAddress(headers: Headers): string | null {
  const parts = (headers.get('x-forwarded-for') ?? '').split(',');
  const last = parts[parts.length - 1]?.trim().replace(/^::ffff:/i, '');
  return last && isIP(last) ? last : null;
}

export type ExitDecision = { ok: true } | { ok: false; status: number };

export function authorizeExit(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): ExitDecision {
  if (request.method !== 'POST') return { ok: false, status: 405 };

  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return { ok: false, status: 403 };

  const address = clientAddress(request.headers);
  if (!address) return { ok: false, status: 403 };

  const configured = env.EXIT_ALLOWED_CIDRS?.split(',').filter((c) => c.trim());
  const list = buildList(configured?.length ? configured : DEFAULT_ALLOWED);
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  return list.check(address, family)
    ? { ok: true }
    : { ok: false, status: 403 };
}
