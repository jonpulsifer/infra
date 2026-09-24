/**
 * The Apps' wildcard route sends every App name to this listener and
 * `Bun.serve` matches by path alone, so each route is confined to its hosts here.
 */
import { isIPv4, isIPv6 } from 'node:net';
import { BOSUN_PATHS } from './bosun-route.ts';
import { MCP_PATH } from './mcp-route.ts';
import { HEALTH_PATH, READY_PATH } from './routes.ts';
import { STATUS_PATH } from './status-route.ts';
import { WEBHOOK_PATH } from './webhook-route.ts';

/** The Service in front of the web pod, as the chart names it. */
export const SERVICE_NAME_VAR = 'SPINDRIFT_SERVICE_NAME';
export const SERVICE_NAMESPACE_VAR = 'SPINDRIFT_SERVICE_NAMESPACE';

export interface ServedHosts {
  /** Every route answers here. */
  readonly controlPlane: string;
  /** The machine-authenticated routes answer here as well. */
  readonly public: string | null;
  /** And here, for a pod calling the Service directly. */
  readonly inCluster: readonly string[];
}

/**
 * No edge forwards a name outside its own zones, so none of these can arrive
 * from outside the cluster.
 */
export function inClusterHostnames(
  env: Record<string, string | undefined>,
): string[] {
  const service = env[SERVICE_NAME_VAR]?.trim().toLowerCase();
  const namespace = env[SERVICE_NAMESPACE_VAR]?.trim().toLowerCase();
  if (!service || !namespace) return [];
  const qualified = `${service}.${namespace}.svc`;
  return [
    service,
    `${service}.${namespace}`,
    qualified,
    `${qualified}.cluster.local`,
  ];
}

const MACHINE_PATHS: ReadonlySet<string> = new Set([
  WEBHOOK_PATH,
  ...BOSUN_PATHS,
  MCP_PATH,
]);

const PROBE_PATHS: ReadonlySet<string> = new Set([HEALTH_PATH, READY_PATH]);

type Handler = (request: Request, server: unknown) => unknown;

/** A request on any other host gets what an unmatched path on it would. */
export function scopeToHost<T extends Record<string, unknown>>(
  routes: T,
  hosts: ServedHosts,
): T {
  const status = routes[STATUS_PATH] as Handler;
  const controlPlane = hosts.controlPlane.toLowerCase();
  const machine = new Set(
    [hosts.public, ...hosts.inCluster].flatMap((host) =>
      host ? [host.toLowerCase()] : [],
    ),
  );

  const answers = (path: string, host: string | null) =>
    host !== null &&
    (host === controlPlane ||
      (MACHINE_PATHS.has(path) && machine.has(host)) ||
      (PROBE_PATHS.has(path) && isAddress(host)));

  const scoped: Record<string, unknown> = {};
  for (const [path, route] of Object.entries(routes)) {
    if (path === STATUS_PATH) {
      scoped[path] = route;
      continue;
    }
    const handler = asHandler(path, route);
    scoped[path] = (request: Request, server: unknown) =>
      answers(path, hostOf(request))
        ? handler(request, server)
        : status(request, server);
  }
  return scoped as T;
}

function asHandler(path: string, route: unknown): Handler {
  if (route instanceof Response) return () => route.clone();
  if (typeof route === 'function') return route as Handler;
  throw new TypeError(`${path} is a route no handler can scope to a host`);
}

/** Lowercased and without its port; `null` for anything but a bare host. */
function hostOf(request: Request): string | null {
  const host = (request.headers.get('host') ?? '').toLowerCase();
  const match = /^(\[[0-9a-f:.]+\]|[^:[\]]+)(?::\d+)?$/.exec(host);
  return match?.[1] ?? null;
}

/** The kubelet probes by pod address; an edge only ever forwards a name. */
function isAddress(host: string): boolean {
  return host.startsWith('[') ? isIPv6(host.slice(1, -1)) : isIPv4(host);
}
