/**
 * The page an App's address shows before anything serves it. Exact routes win
 * over this wildcard, both at the Gateway and in `Bun.serve`.
 */
import { desc, eq } from 'drizzle-orm';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { apps, components, deploys } from '../db/schema.ts';
import {
  componentCanonical,
  type DnsZones,
  vanity,
  zoneFor,
} from '../domain/naming.ts';
import { PRODUCT_NAME } from './brand.ts';

/** Matched after every exact path; the page is chosen by the `Host` header. */
export const STATUS_PATH = '/*';

export interface StatusRouteDeps {
  readonly db: Database;
  /** Called per request: the zones and hostname it reads change at runtime. */
  current(): Promise<{ readonly manifest: InstallationManifest }>;
}

export function statusRoutes(deps: StatusRouteDeps) {
  return {
    [STATUS_PATH]: (request: Request) => statusResponse(request, deps),
  };
}

/**
 * `unrouted`: the newest Deploy is `LIVE`, yet the request reached this
 * wildcard, so the Component's exact route is gone.
 */
type Standing =
  | 'unclaimed'
  | 'unreleased'
  | 'deploying'
  | 'failed'
  | 'unrouted';

const SAID: Record<Standing, { title: string; detail: string }> = {
  unclaimed: {
    title: 'No app here',
    detail: 'Nothing in this installation answers to this name.',
  },
  unreleased: {
    title: 'Waiting for a first release',
    detail:
      'This app exists and its address is reserved. Nothing has been deployed to it yet.',
  },
  deploying: {
    title: 'Deploying',
    detail: 'A release is on its way here. This page will follow it.',
  },
  failed: {
    title: 'The last release failed',
    detail:
      'Nothing is serving this address. The deploy that would have is in the control plane.',
  },
  unrouted: {
    title: 'Not routed',
    detail:
      'A release is live, but nothing is currently routing this name to it.',
  },
};

async function statusResponse(
  request: Request,
  deps: StatusRouteDeps,
): Promise<Response> {
  const { manifest } = await deps.current();
  const host = hostOf(request);

  // The control plane's own name here is a console path missing from the table.
  if (host === '' || host === manifest.controlPlane.hostname.toLowerCase()) {
    return new Response('not found\n', { status: 404 });
  }

  const standing = await standingFor(deps.db, manifest.dns.zones, host);
  return page(host, standing);
}

function hostOf(request: Request): string {
  return (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
}

async function standingFor(
  db: Database,
  zones: DnsZones,
  host: string,
): Promise<Standing> {
  // ponytail: names are minted and compared in memory, one unindexed query.
  // The upgrade path stores the chart's hostnames and looks this up by one.
  const placed = await db
    .select({
      id: components.id,
      component: components.name,
      reach: components.reach,
      app: apps.name,
      zone: apps.zone,
      vanityDomain: apps.vanityDomain,
    })
    .from(components)
    .innerJoin(apps, eq(components.appId, apps.id));

  const match = placed.find((row) => namesFor(row, zones).includes(host));
  if (match === undefined) return 'unclaimed';

  const [newest] = await db
    .select({ phase: deploys.phase })
    .from(deploys)
    .where(eq(deploys.componentId, match.id))
    .orderBy(desc(deploys.createdAt))
    .limit(1);

  if (newest === undefined) return 'unreleased';
  if (newest.phase === 'LIVE') return 'unrouted';
  if (newest.phase === 'FAILED') return 'failed';
  return 'deploying';
}

/**
 * Minted from the naming primitives, not `hostnameFor`, which returns an empty
 * canonical for backends that name their own workloads.
 */
function namesFor(
  row: {
    app: string;
    component: string;
    reach: 'none' | 'private' | 'public';
    zone: string | null;
    vanityDomain: string | null;
  },
  zones: DnsZones,
): string[] {
  const zone = zoneFor(row.reach, zones, row.zone);
  if (zone === null) return [];
  const names = [
    componentCanonical({ app: row.app, component: row.component, zone }),
  ];
  if (row.vanityDomain !== null) {
    names.push(vanity(row.vanityDomain, zone));
  }
  return names;
}

/**
 * Served to anyone without a session, so it loads no bundle and shows only the
 * name and its state. With no script, a `meta` tag does the refresh.
 */
function page(host: string, standing: Standing): Response {
  const { title, detail } = SAID[standing];
  const waiting = standing !== 'unclaimed';
  const safeHost = Bun.escapeHTML(host);

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${waiting ? '<meta http-equiv="refresh" content="5">' : ''}
<title>${safeHost}</title>
<style>
:root { color-scheme: dark; }
body {
  margin: 0; min-height: 100vh;
  display: grid; place-items: center;
  background: #150b22; color: #f7f0fc;
  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
}
main { max-width: 34rem; padding: 2rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; font-weight: 600; }
p { margin: 0 0 1.5rem; color: #cdb9dd; }
code { color: #ff3fb5; font-family: ui-monospace, monospace; }
small { color: #a892bf; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${detail}</p>
<p><code>${safeHost}</code></p>
<small>${PRODUCT_NAME.toLowerCase()}${waiting ? ' &middot; this page refreshes itself' : ''}</small>
</main>
</body>
</html>
`;

  return new Response(body, {
    // 503 for every other state: the address is not serving what was asked.
    status: standing === 'unclaimed' ? 404 : 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(waiting ? { 'retry-after': '5' } : {}),
    },
  });
}
