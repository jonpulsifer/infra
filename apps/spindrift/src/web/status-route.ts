/**
 * What an App's address says before anything is serving it (§9, §21).
 *
 * §21 wants an App to carry a lowest-precedence route from the moment it
 * exists, so a name Spindrift has minted resolves to a page that says where the
 * App is up to rather than to a connection error. `controlPlane.hostname` is
 * the field that makes one process able to serve both surfaces — a request for
 * this installation's own UI and a request for one of its Apps arrive on the
 * same listener and are told apart by nothing else.
 *
 * **Precedence is the edge's, not this file's.** In the cluster the Apps'
 * Gateway holds one wildcard listener per zone, and Gateway API orders matching
 * routes by hostname specificity — an exact hostname beats `*.zone`. So the
 * route that carries traffic here is the one no deployed Component has claimed,
 * and a Component going live takes its own name back without anything here
 * being told. Inside this process the same thing holds for a different reason:
 * `{@link STATUS_PATH}` is a wildcard, and `Bun.serve` matches every exact path
 * in the table ahead of it.
 *
 * **It answers 503, not 200.** Every state this page reports is an address that
 * is not serving what a caller asked for, and the honest status code for that
 * is the one that says so — a monitor that treats this page as the App being up
 * would be wrong in exactly the case the page exists to describe.
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

/**
 * The lowest-precedence path in the table.
 *
 * A hand-authored route, which `routes.ts` asks to be a decision made on
 * purpose: this is the eleventh kind, and it is the only one that reads the
 * `Host` header rather than the path.
 */
export const STATUS_PATH = '/*';

export interface StatusRouteDeps {
  readonly db: Database;
  /**
   * Current as of this request, for the same reason every other route that
   * reads the manifest takes it as a call rather than a value: `dns.zones` and
   * `controlPlane.hostname` decide which names this page answers for, and a
   * process-lifetime copy would go stale the moment an operator adds a zone.
   */
  current(): Promise<{ readonly manifest: InstallationManifest }>;
}

export function statusRoutes(deps: StatusRouteDeps) {
  return {
    [STATUS_PATH]: (request: Request) => statusResponse(request, deps),
  };
}

/**
 * Where an address is up to.
 *
 * `unrouted` is the state that looks impossible and is not: a Component whose
 * newest Deploy is `LIVE` should be holding its own exact route, so a request
 * that arrived at the wildcard instead means the route is gone while the record
 * still points here. Reporting it as "live" would be this page contradicting
 * the request that reached it.
 */
type Standing =
  | 'unclaimed'
  | 'unreleased'
  | 'deploying'
  | 'failed'
  | 'unrouted';

/** What the page says, per state. */
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

  // The control plane's own name reaching a wildcard means a path that is not
  // in the table — a 404 for the console, not a status page about an App.
  if (host === '' || host === manifest.controlPlane.hostname.toLowerCase()) {
    return new Response('not found\n', { status: 404 });
  }

  const standing = await standingFor(deps.db, manifest.dns.zones, host);
  return page(host, standing);
}

/** The requested name, lowercased and without its port. */
function hostOf(request: Request): string {
  return (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();
}

async function standingFor(
  db: Database,
  zones: DnsZones,
  host: string,
): Promise<Standing> {
  // ponytail: every Component's names are minted and compared in memory, which
  // is one query and no index for as long as an installation's Components fit
  // in a page. The upgrade path is storing the hostnames the chart is already
  // handed and looking this up by one of them.
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
 * Every name this Component could be reached at, from the same primitives the
 * deploy loop mints the real ones with.
 *
 * Deliberately not `hostnameFor`: that answers what core hands an adapter, and
 * returns an empty canonical for the backends that name their own workloads.
 * The question here is the other one — which Component a caller is asking
 * about — and a name the platform ended up serving is still that Component's.
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
 * The page.
 *
 * Server-rendered and self-contained: it is served to whoever asks, with no
 * session, so it loads nothing from the client bundle and says nothing an
 * operator would mind a stranger reading — a name, and whether it is serving.
 *
 * The refresh is a `meta` tag rather than script because this page has no
 * bundle to put script in, and because the state it is waiting for changes on
 * the order of seconds. It is set only where there is something to wait for.
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
  background: #0b1120; color: #e2e8f0;
  font: 16px/1.6 ui-sans-serif, system-ui, sans-serif;
}
main { max-width: 34rem; padding: 2rem; }
h1 { font-size: 1.5rem; margin: 0 0 .5rem; font-weight: 600; }
p { margin: 0 0 1.5rem; color: #94a3b8; }
code { color: #e2e8f0; font-family: ui-monospace, monospace; }
small { color: #64748b; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${detail}</p>
<p><code>${safeHost}</code></p>
<small>spindrift${waiting ? ' &middot; this page refreshes itself' : ''}</small>
</main>
</body>
</html>
`;

  return new Response(body, {
    status: standing === 'unclaimed' ? 404 : 503,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(waiting ? { 'retry-after': '5' } : {}),
    },
  });
}
