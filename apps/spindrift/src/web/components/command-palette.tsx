/**
 * The ⌘K palette. It only navigates; destructive acts stay beside their object.
 * It reads its own catalogue on first open and keeps it while mounted.
 */
import { Boxes, Hammer, Rocket, Search, Server } from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  TargetListItem,
} from '../../commands/views.ts';
import { command } from '../client.ts';
import { Kbd } from '../ui/kbd.tsx';
import { cn } from '../ui/utils.ts';

export interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  /** What tells apart two rows with the same label. */
  readonly hint?: string;
  readonly path: string;
}

export interface PaletteCatalogue {
  readonly apps: readonly AppListItem[];
  readonly builds: readonly BuildListItem[];
  readonly deploys: readonly DeployLedgerItem[];
  readonly targets: readonly TargetListItem[];
}

// Listed first, so an empty query offers places to go.
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
    id: 'go:/datastores',
    group: 'Go to',
    label: 'Datastores',
    path: '/datastores',
  },
  {
    id: 'go:/functions',
    group: 'Go to',
    label: 'Functions',
    path: '/functions',
  },
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
      // Both halves, or two clusters on one adapter read as the same row.
      label: `${target.vessel}/${target.adapter}`,
      hint: 'Connections',
      path: '/settings/connections',
    })),
  ];
}

/**
 * Lower sorts first, and -1 is no match. A substring scores by position, and a
 * subsequence scores behind every substring.
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

/** Rows the overlay draws; nobody reads further. */
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

/** Guarded because tests render this to static markup with no `navigator`. */
export function metaKeyGlyph(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  const platform = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`;
  return /Mac|iPhone|iPad/.test(platform) ? '⌘' : 'Ctrl';
}

export function CommandPalette({
  onNavigate,
  open: openProp,
  onOpenChange,
  triggerClassName,
}: {
  readonly onNavigate: (path: string) => void;
  /** Lets the rail's Search row open this. Omitted, the palette owns it. */
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Hiding the trigger with this leaves Cmd/Ctrl-K working. */
  readonly triggerClassName?: string;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = onOpenChange ?? setOpenState;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [catalogue, setCatalogue] = useState<PaletteCatalogue | null>(null);
  const [glyph] = useState(metaKeyGlyph);

  // Every opening starts from a clean query, whatever raised it.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!open);
      }
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  // Read on first open. A failed read leaves `catalogue` null and the verbs
  // still navigate.
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
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-2 rounded-sm border border-border px-2.5 py-1.5 text-body text-muted-foreground hover:text-foreground',
          triggerClassName,
        )}
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
          {/* Out of the tab order: Escape is the keyboard's way out, and a tab
              stop here would sit between the reader and the input. */}
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
