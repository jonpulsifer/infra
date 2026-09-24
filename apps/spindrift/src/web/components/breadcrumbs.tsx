/**
 * The header's breadcrumb trail, derived from the path alone so it never waits
 * on a loading screen.
 */

import { WORDMARK } from '../brand.ts';

export interface Crumb {
  readonly label: string;
  /** Absent on the last crumb: it is where the reader already is. */
  readonly path?: string;
}

// The Settings roots in `components/shell.tsx` carry the same list.
const SETTINGS_ROOTS = new Set(['settings', 'targets', 'repos', 'storage']);

/** The supply chain stages, which share one rail entry. */
const SUPPLY_CHAIN: Record<string, string> = {
  builds: 'Builds',
  sources: 'Sources',
  artifacts: 'Artifacts',
};

function sentence(segment: string): string {
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

function trail(path: string): Crumb[] {
  const [head, ...rest] = path.split('/').filter(Boolean);
  if (head === undefined) return [{ label: 'Overview', path: '/' }];

  if (SETTINGS_ROOTS.has(head)) {
    // `/targets`, `/repos` and `/storage` all open Connections.
    const section =
      head === 'settings' ? (rest[0] ?? 'connections') : 'connections';
    return [
      { label: 'Settings', path: '/settings/connections' },
      { label: sentence(section), path: `/settings/${section}` },
    ];
  }

  const stage = SUPPLY_CHAIN[head];
  if (stage !== undefined) {
    const crumbs: Crumb[] = [
      { label: 'Supply chain', path: '/builds' },
      { label: stage, path: `/${head}` },
    ];
    if (rest[0]) crumbs.push({ label: `#${rest[0]}`, path });
    return crumbs;
  }

  if (head === 'deploys') {
    const crumbs: Crumb[] = [{ label: 'Deploys', path: '/deploys' }];
    if (rest[0]) crumbs.push({ label: `#${rest[0]}`, path });
    return crumbs;
  }

  // A Datastore id is a uuid, so the trail stops at the noun.
  if (head === 'datastores') {
    return [{ label: 'Datastores', path: '/datastores' }];
  }

  // Everything left names an App, including a bare `/<name>`.
  const crumbs: Crumb[] = [{ label: 'Apps', path: '/apps' }];
  const tail = head === 'apps' ? rest : [head];
  if (tail[0] === 'new') {
    crumbs.push({ label: 'New App', path: '/apps/new' });
  } else if (tail[0]) {
    crumbs.push({ label: tail[0], path });
  }
  return crumbs;
}

export function crumbsFor(path: string): readonly Crumb[] {
  const crumbs = trail(path);
  return crumbs.map((crumb, index) =>
    index === crumbs.length - 1 ? { label: crumb.label } : crumb,
  );
}

export function Breadcrumbs({
  path,
  onNavigate,
}: {
  readonly path: string;
  readonly onNavigate: (path: string) => void;
}) {
  const crumbs = crumbsFor(path);

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 font-mono text-micro font-bold tracking-eyebrow text-muted-foreground">
        <li className="shrink-0">{WORDMARK} /</li>
        {crumbs.map((crumb, index) => (
          <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.path === undefined ? (
              <span aria-current="page" className="truncate text-foreground">
                {crumb.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onNavigate(crumb.path ?? '/')}
                className="truncate rounded-sm hover:text-foreground focus-visible:-outline-offset-2"
              >
                {crumb.label}
              </button>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}
