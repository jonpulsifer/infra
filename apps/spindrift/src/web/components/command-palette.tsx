/**
 * Everything in the installation, one keystroke away.
 *
 * Before this the entire application contained exactly one `onKeyDown` handler,
 * and reaching a named App meant: rail → Apps → wait for the list → filter →
 * press. Four of those five steps exist only because the reader had to arrive
 * somewhere that knows the name before they could type it. A palette collapses
 * them into typing the name.
 *
 * **It reads its own catalogue rather than being handed one.** The four lists
 * it searches live in four different screens' `useState`, so a palette fed from
 * props would only know about objects on the screen the reader happened to be
 * looking at — which is the navigation problem restated, not solved. Instead it
 * fires the same four reads `OverviewScreen` fires, once, the first time it is
 * opened: nothing is fetched for a reader who never presses ⌘K, and the result
 * is cached for the session because a palette that re-fetches on every open is
 * a palette with a spinner in it.
 *
 * **Navigation only.** Every entry resolves to a path. Destructive acts are not
 * in here and should not be: a palette is a place where the reader is typing
 * fast and confirming on muscle memory, and "delete" three characters away from
 * "deploys" is how an App goes missing. Acts stay beside the object they affect.
 *
 * The trigger renders here too, beside the overlay, because they are one piece
 * of state. A shortcut nobody can see is a shortcut nobody uses, so the header
 * carries the affordance and `Kbd` carries the key.
 */
import { Boxes, Hammer, Rocket, Search, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import { command } from '../client.ts';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  TargetListItem,
} from '../model.ts';
import { Kbd } from '../ui/kbd.tsx';
import { cn } from '../ui/utils.ts';

export interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  /** The second line: what distinguishes two rows that read alike. */
  readonly hint?: string;
  readonly path: string;
}

export interface PaletteCatalogue {
  readonly apps: readonly AppListItem[];
  readonly builds: readonly BuildListItem[];
  readonly deploys: readonly DeployLedgerItem[];
  readonly targets: readonly TargetListItem[];
}

/**
 * The verbs, which are the rail plus the two destinations the rail has no room
 * for. They are listed first so an empty query offers somewhere to go rather
 * than the twelve newest Builds.
 */
const VERBS: readonly PaletteItem[] = [
  { id: 'go:/', group: 'Go to', label: 'Overview', path: '/' },
  { id: 'go:/apps', group: 'Go to', label: 'Apps', path: '/apps' },
  {
    id: 'go:/apps/new',
    group: 'Go to',
    label: 'New App',
    hint: 'Create an App',
    path: '/apps/new',
  },
  { id: 'go:/builds', group: 'Go to', label: 'Builds', path: '/builds' },
  { id: 'go:/sources', group: 'Go to', label: 'Sources', path: '/sources' },
  {
    id: 'go:/artifacts',
    group: 'Go to',
    label: 'Artifacts',
    path: '/artifacts',
  },
  { id: 'go:/deploys', group: 'Go to', label: 'Deploys', path: '/deploys' },
  {
    id: 'go:/settings/connections',
    group: 'Go to',
    label: 'Connections',
    hint: 'Settings',
    path: '/settings/connections',
  },
  {
    id: 'go:/settings/identity',
    group: 'Go to',
    label: 'Identity',
    hint: 'Settings',
    path: '/settings/identity',
  },
];

/**
 * A Target is `vessel/adapter` and never one of them alone — `model.ts:744` is
 * explicit about it, and two clusters both running `kubernetes` are otherwise
 * the same row twice.
 */
export function paletteItems(
  catalogue: PaletteCatalogue | null,
): readonly PaletteItem[] {
  if (catalogue === null) return VERBS;
  return [
    ...VERBS,
    ...catalogue.apps.map((app) => ({
      id: `app:${app.id}`,
      group: 'Apps',
      label: app.name,
      hint: app.vessel ? `${app.vessel}/${app.target}` : app.target,
      path: `/apps/${app.id}`,
    })),
    ...catalogue.deploys.map((deploy) => ({
      id: `deploy:${deploy.id}`,
      group: 'Deploys',
      label: `#${deploy.id} ${deploy.app}`,
      hint: `${deploy.component} · ${deploy.commit}`,
      path: `/deploys/${deploy.id}`,
    })),
    ...catalogue.builds.map((build) => ({
      id: `build:${build.id}`,
      group: 'Builds',
      label: `#${build.id} ${build.app}`,
      hint: `${build.component} · ${build.commit}`,
      path: `/builds/${build.id}`,
    })),
    ...catalogue.targets.map((target) => ({
      id: `target:${target.id}`,
      group: 'Targets',
      label: `${target.vessel}/${target.adapter}`,
      hint: 'Connections',
      path: '/settings/connections',
    })),
  ];
}

/**
 * Substring first, subsequence second, and nothing clever after that.
 *
 * A lower number sorts earlier. A direct hit scores by where it landed, so
 * typing `mor` puts `morrow` above `checkout-mortgage`; a subsequence match is
 * pushed behind every substring match by a constant, because `dpl` finding
 * `deploys` is useful and should never outrank a literal one.
 */
function rank(haystack: string, needle: string): number {
  const text = haystack.toLowerCase();
  const direct = text.indexOf(needle);
  if (direct !== -1) return direct;
  let at = 0;
  for (const character of needle) {
    const next = text.indexOf(character, at);
    if (next === -1) return -1;
    at = next + 1;
  }
  return 1_000 + at;
}

/** How many rows the overlay will draw. Beyond this nobody is reading. */
const SHOWN = 12;

export function filterPalette(
  items: readonly PaletteItem[],
  query: string,
): readonly PaletteItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return items.slice(0, SHOWN);
  return items
    .map((item) => ({
      item,
      score: rank(`${item.label} ${item.hint ?? ''}`, needle),
    }))
    .filter(({ score }) => score !== -1)
    .sort((left, right) => left.score - right.score)
    .slice(0, SHOWN)
    .map(({ item }) => item);
}

const GROUP_ICON: Record<string, typeof Boxes> = {
  Apps: Boxes,
  Builds: Hammer,
  Deploys: Rocket,
  Targets: Server,
};

/**
 * ⌘ on a Mac, Ctrl everywhere else — a fact about the reader's keyboard, so it
 * is read once and never re-derived. Guarded because this component is rendered
 * to static markup in tests, where there is no `navigator`.
 */
function metaKeyGlyph(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl';
}

export function CommandPalette({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [catalogue, setCatalogue] = useState<PaletteCatalogue | null>(null);
  const [glyph] = useState(metaKeyGlyph);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setActive(0);
        setOpen((current) => !current);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, []);

  // Once, on first open. A failed read leaves `catalogue` null and the palette
  // still navigates — the verbs are the half that never needed the server.
  useEffect(() => {
    if (!open || catalogue !== null) return;
    let live = true;
    void Promise.all([
      command('listApps', {}),
      command('listBuilds', { limit: 25 }),
      command('listAllDeploys', { limit: 25 }),
      command('listTargets', {}),
    ])
      .then(([apps, builds, deploys, targets]) => {
        if (!live) return;
        setCatalogue({
          apps: apps.ok ? apps.value.apps : [],
          builds: builds.ok ? builds.value.builds : [],
          deploys: deploys.ok ? deploys.value.deploys : [],
          targets: targets.ok ? targets.value.targets : [],
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, catalogue]);

  const shown = filterPalette(paletteItems(catalogue), query);
  const selected = shown[Math.min(active, shown.length - 1)];

  const choose = (item: PaletteItem | undefined) => {
    if (item === undefined) return;
    setOpen(false);
    onNavigate(item.path);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setQuery('');
          setActive(0);
          setOpen(true);
        }}
        className="flex items-center gap-2 rounded-sm border border-border px-2.5 py-1.5 text-body text-muted-foreground hover:text-foreground"
      >
        <Search aria-hidden="true" className="size-3.5" />
        <span className="hidden sm:inline">Search</span>
        <span className="hidden sm:flex items-center gap-0.5">
          <Kbd>{glyph}</Kbd>
          <Kbd>K</Kbd>
        </span>
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
          {/* A press on the backdrop is a press on nothing, which is the
              universal "I did not mean to open this". A real button rather than
              a click handler on the overlay div, because that is what it is —
              and it is out of the tab order because Escape is the keyboard's
              way out and a tab stop labelled "close" ahead of the input would
              be one press between the reader and typing. */}
          <button
            type="button"
            tabIndex={-1}
            aria-label="Close the command palette"
            onMouseDown={() => setOpen(false)}
            className="absolute inset-0 bg-overlay"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="relative w-full max-w-xl overflow-hidden rounded-lg border border-border bg-card shadow-panel"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setOpen(false);
              } else if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActive((index) => Math.min(index + 1, shown.length - 1));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActive((index) => Math.max(index - 1, 0));
              } else if (event.key === 'Enter') {
                event.preventDefault();
                choose(selected);
              }
            }}
          >
            <div className="flex items-center gap-2 border-b border-border px-3.5 py-3">
              <Search
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground"
              />
              <input
                // The palette exists to be typed into, and it was opened by a
                // keystroke — focus is already the reader's, not stolen.
                // biome-ignore lint/a11y/noAutofocus: see above
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                aria-label="Search Apps, Deploys, Builds and Targets"
                placeholder="Search Apps, Deploys, Builds and Targets…"
                className="w-full bg-transparent text-ui outline-none placeholder:text-muted-foreground"
              />
              <Kbd>Esc</Kbd>
            </div>
            <ul className="max-h-[50vh] overflow-y-auto py-1">
              {shown.length === 0 ? (
                <li className="px-3.5 py-6 text-center text-body text-muted-foreground">
                  Nothing matches “{query}”.
                </li>
              ) : (
                shown.map((item, index) => {
                  const Icon = GROUP_ICON[item.group];
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        aria-current={item === selected ? 'true' : undefined}
                        onMouseEnter={() => setActive(index)}
                        onClick={() => choose(item)}
                        className={cn(
                          'flex w-full items-center gap-2.5 px-3.5 py-2 text-left',
                          item === selected
                            ? 'bg-secondary text-foreground'
                            : 'text-subtle',
                        )}
                      >
                        {Icon ? (
                          <Icon
                            aria-hidden="true"
                            className="size-3.5 shrink-0 text-muted-foreground"
                          />
                        ) : (
                          <span aria-hidden="true" className="size-3.5" />
                        )}
                        <span className="truncate text-body font-medium">
                          {item.label}
                        </span>
                        {item.hint ? (
                          <span className="truncate font-mono text-caption text-muted-foreground">
                            {item.hint}
                          </span>
                        ) : null}
                        <span className="ml-auto shrink-0 text-caption text-muted-foreground">
                          {item.group}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
