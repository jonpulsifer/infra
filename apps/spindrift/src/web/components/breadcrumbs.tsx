/**
 * Where you are, all of it — not just the first segment.
 *
 * The header used to read `SPINDRIFT / {title(path)}`, where `title` took the
 * first path segment and capitalised it. So `/apps/morrow` said **Apps**, and
 * `/deploys/1187` said **Deploys**, and every detail screen in the product
 * shared a crumb with the ledger it was opened from. The one place the chrome
 * is asked "which object is this" answered "the kind of object it is".
 *
 * The trail is derived from the path and nothing else. That is deliberate: the
 * shell would otherwise need every screen to hand it a display name, which is a
 * prop threaded through six route branches to duplicate a string the URL is
 * already carrying — and one that would be blank for the second or two the
 * screen spends loading, which is exactly when a reader looks up to check where
 * they landed. The last segment of `/apps/morrow` *is* the App's identity;
 * printing it is honest, and it never lags.
 *
 * Two things it refuses. It is not a router — a crumb's `path` is handed back
 * to `onNavigate`, and nothing here knows what those paths render. And the
 * final crumb carries no path at all: a link to the page you are on is a
 * control that does nothing, and readers press it to try to reload.
 *
 * The literal `SPINDRIFT /` stays. It is the product's name in the one piece of
 * chrome present on every screen, and `object-explorer.test.tsx` pins it.
 */

export interface Crumb {
  readonly label: string;
  /** Absent on the last crumb: it is where the reader already is. */
  readonly path?: string;
}

/**
 * The three roots that stopped being screens and became sections of Settings —
 * `components/shell.tsx`'s `NAVIGATION` carries the same list for the same
 * reason.
 */
const SETTINGS_ROOTS = new Set(['settings', 'targets', 'repos', 'storage']);

/** §2's chain read left to right, and the one rail entry it collapses into. */
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
    // `/targets`, `/repos` and `/storage` all land on Connections, so the crumb
    // names the section the reader is actually looking at rather than the path
    // they typed.
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

  // No detail route — `getAppWorkspace` still owns a single Datastore's
  // detail, so this is one crumb rather than a branch that also names an id.
  if (head === 'datastores') {
    return [{ label: 'Datastores', path: '/datastores' }];
  }

  // Everything left names an App, including the bare `/<name>` the route table
  // still answers for a link written before `/apps/` existed.
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
        <li className="shrink-0">SPINDRIFT /</li>
        {crumbs.map((crumb, index) => (
          <li key={crumb.label} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {crumb.path === undefined ? (
              // `aria-current="page"` on the text, not on a control: this is the
              // crumb for the screen already on display.
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
