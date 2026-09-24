import {
  Bot,
  Boxes,
  Database,
  Hammer,
  LayoutDashboard,
  LogOut,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Rocket,
  Search,
  Server,
  Settings,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';
import type { Principal } from '../../commands/types.ts';
import {
  type AppListItem,
  deployPhaseWord,
  isInFlight,
} from '../../commands/views.ts';
import { PRODUCT_NAME } from '../brand.ts';
import { isReconnecting, onConnectionChange } from '../connection-status.ts';
import { useRead } from '../poll.ts';
import { Button } from '../ui/button.tsx';
import { Kbd } from '../ui/kbd.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { ToastHost } from '../ui/toast.tsx';
import { cn } from '../ui/utils.ts';
import { Breadcrumbs } from './breadcrumbs.tsx';
import { CommandPalette, metaKeyGlyph } from './command-palette.tsx';
import { Roflcopter } from './roflcopter.tsx';
import { AppDot } from './status.tsx';
import { Wordmark } from './wordmark.tsx';

/**
 * `path` is where a click goes and `roots` are the prefixes that light the
 * entry. Outside Settings, `path` is one of `roots`, so a click lights its row.
 */
interface RailDestination {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly path: string;
  readonly roots: readonly string[];
}

/**
 * Targets links to `/targets`, which opens Connections, so a click lights
 * Targets and not the Settings entry.
 */
export const WORKSPACE: readonly RailDestination[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    path: '/',
    roots: ['/'],
  },
  {
    key: 'deploys',
    label: 'Deploys',
    icon: Rocket,
    path: '/deploys',
    roots: ['/deploys'],
  },
  {
    key: 'supply-chain',
    label: 'Supply chain',
    icon: Hammer,
    path: '/builds',
    roots: ['/builds', '/sources', '/artifacts'],
  },
  {
    key: 'datastores',
    label: 'Datastores',
    icon: Database,
    path: '/datastores',
    roots: ['/datastores'],
  },
  {
    key: 'functions',
    label: 'Functions',
    icon: Zap,
    path: '/functions',
    roots: ['/functions'],
  },
  {
    key: 'targets',
    label: 'Targets',
    icon: Server,
    path: '/targets',
    roots: ['/targets', '/repos', '/storage'],
  },
];

/** MCP opens the identity settings, where agent tokens are minted. */
export const DEVELOPER: readonly RailDestination[] = [
  {
    key: 'mcp',
    label: 'MCP',
    icon: Bot,
    path: '/settings/identity',
    roots: ['/settings/identity'],
  },
];

/** Lights for any `/settings` path no more specific entry claims. */
export const FOOTER_SETTINGS: RailDestination = {
  key: 'settings',
  label: 'Settings',
  icon: Settings,
  path: '/settings/connections',
  roots: ['/settings'],
};

/**
 * The phone bar: Apps is one link, and Targets and MCP fold into Settings.
 * Datastores and Functions keep their own, since no Settings tab reaches them.
 */
export const PHONE_NAV: readonly RailDestination[] = [
  {
    key: 'overview',
    label: 'Overview',
    icon: LayoutDashboard,
    path: '/',
    roots: ['/'],
  },
  { key: 'apps', label: 'Apps', icon: Boxes, path: '/apps', roots: ['/apps'] },
  {
    key: 'deploys',
    label: 'Deploys',
    icon: Rocket,
    path: '/deploys',
    roots: ['/deploys'],
  },
  {
    key: 'supply-chain',
    label: 'Supply chain',
    icon: Hammer,
    path: '/builds',
    roots: ['/builds', '/sources', '/artifacts'],
  },
  {
    key: 'datastores',
    label: 'Datastores',
    icon: Database,
    path: '/datastores',
    roots: ['/datastores'],
  },
  {
    key: 'functions',
    label: 'Functions',
    icon: Zap,
    path: '/functions',
    roots: ['/functions'],
  },
  {
    key: 'settings',
    label: 'Settings',
    icon: Settings,
    path: '/settings/connections',
    roots: ['/settings', '/targets', '/repos', '/storage'],
  },
];

/** Apps the rail lists before "All apps" takes over. */
const RAIL_APPS_CAP = 8;

// A per-browser preference, stored beside the theme key.
const RAIL_KEY = 'spindrift.rail';

/**
 * Guarded for static test renders, which have no `localStorage`. An unreadable
 * preference means expanded.
 */
function railCollapsed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(RAIL_KEY) === 'collapsed';
  } catch {
    return false;
  }
}

function rememberRail(collapsed: boolean): void {
  try {
    localStorage.setItem(RAIL_KEY, collapsed ? 'collapsed' : 'expanded');
  } catch {
    // A blocked or full store only loses the preference for this visit.
  }
}

function under(path: string, root: string): boolean {
  if (root === '/') return path === '/';
  return path === root || path.startsWith(`${root}/`);
}

/** The length of the longest matching root, or -1 for none. */
function specificity(path: string, roots: readonly string[]): number {
  let best = -1;
  for (const root of roots) {
    if (under(path, root)) best = Math.max(best, root.length);
  }
  return best;
}

/**
 * The most specific root wins, so an entry for a section of Settings outranks
 * the one for all of it. At most one candidate lights.
 */
export function activeKey(
  path: string,
  candidates: readonly {
    readonly key: string;
    readonly roots: readonly string[];
  }[],
): string | undefined {
  let winner: string | undefined;
  let best = -1;
  for (const candidate of candidates) {
    const score = specificity(path, candidate.roots);
    if (score > best) {
      best = score;
      winner = candidate.key;
    }
  }
  return winner;
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length > 1
      ? `${parts[0]![0]}${parts.at(-1)![0]}`
      : (parts[0]?.slice(0, 2) ?? 'OP')
  ).toUpperCase();
}

/**
 * A native popover, so the platform handles the top layer, Escape, outside
 * presses and focus. It sits in the header because phones hide the rail.
 */
function AccountMenu({
  principal,
  onNavigate,
  onSignOut,
}: {
  readonly principal: Principal;
  readonly onNavigate: (path: string) => void;
  readonly onSignOut: () => void;
}) {
  return (
    <>
      <button
        type="button"
        popoverTarget="account-menu"
        aria-label={`Account: ${principal.displayName}`}
        className="flex items-center gap-2 rounded-sm border border-border py-1 pl-1 pr-2 text-body hover:bg-secondary"
      >
        <span
          aria-hidden="true"
          className="grid size-7 place-items-center rounded-sm bg-secondary font-mono text-caption font-bold"
        >
          {initials(principal.displayName)}
        </span>
        <span className="hidden max-w-40 truncate lg:inline">
          {principal.displayName}
        </span>
      </button>
      <div
        id="account-menu"
        popover="auto"
        className="fixed inset-auto right-4 top-[44px] m-0 w-56 rounded-sm border border-border bg-card p-1.5 shadow-panel"
      >
        <p className="truncate px-2 py-1.5 text-caption text-muted-foreground">
          Signed in as{' '}
          <span className="text-foreground">{principal.displayName}</span>
        </p>
        <button
          type="button"
          onClick={() => onNavigate('/settings/identity')}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body hover:bg-secondary"
        >
          <Settings aria-hidden="true" className="size-3.5" />
          Identity and passkeys
        </button>
        <button
          type="button"
          onClick={onSignOut}
          className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-body text-destructive hover:bg-secondary"
        >
          <LogOut aria-hidden="true" className="size-3.5" />
          Sign out
        </button>
      </div>
    </>
  );
}

function RailToggle({
  collapsed,
  onToggle,
  className,
}: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={collapsed}
      aria-label={collapsed ? 'Expand the rail' : 'Collapse the rail'}
      title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
      onClick={onToggle}
      className={cn(
        'flex size-8 shrink-0 items-center justify-center rounded-sm text-rail-muted transition-colors hover:bg-rail-active/60 hover:text-rail-foreground',
        className,
      )}
    >
      {collapsed ? (
        <PanelLeftOpen aria-hidden="true" className="size-[18px]" />
      ) : (
        <PanelLeftClose aria-hidden="true" className="size-[18px]" />
      )}
    </button>
  );
}

/**
 * Always a real `<button>`, so a keyboard reaches it. `detail` states in words
 * what a leading dot shows only in colour.
 */
function RailRow({
  active = false,
  collapsed,
  label,
  detail,
  onClick,
  leading,
  trailing,
  labelClassName,
  className,
}: {
  readonly active?: boolean;
  readonly collapsed: boolean;
  readonly label: string;
  readonly detail?: string;
  readonly onClick: () => void;
  readonly leading: ReactNode;
  readonly trailing?: ReactNode;
  readonly labelClassName?: string;
  readonly className?: string;
}) {
  const name = detail ? `${label}, ${detail}` : label;
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
      className={cn(
        'group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-left text-body transition-colors',
        collapsed && 'justify-center px-0',
        active
          ? 'bg-rail-active text-rail-foreground'
          : 'text-rail-muted hover:bg-rail-active/60 hover:text-rail-foreground',
        className,
      )}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
        />
      ) : null}
      <span className="flex size-4 shrink-0 items-center justify-center">
        {leading}
      </span>
      {collapsed ? null : (
        <>
          <span className={cn('min-w-0 flex-1 truncate', labelClassName)}>
            {label}
          </span>
          {trailing}
        </>
      )}
    </button>
  );
}

/**
 * Named by its visible heading, which stays for screen readers when the rail
 * collapses.
 */
function RailGroup({
  id,
  label,
  collapsed,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly collapsed: boolean;
  readonly children: ReactNode;
}) {
  const headingId = `rail-group-${id}`;
  return (
    <div>
      <h2
        id={headingId}
        className={cn(
          'px-2.5 pb-1 pt-3 text-caption font-medium uppercase tracking-eyebrow text-rail-muted',
          collapsed && 'sr-only',
        )}
      >
        {label}
      </h2>
      <div
        role="group"
        aria-labelledby={headingId}
        className="flex flex-col gap-0.5"
      >
        {children}
      </div>
    </div>
  );
}

function NewAppRow({
  collapsed,
  onClick,
}: {
  readonly collapsed: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      title="New App"
      aria-label="New App"
      onClick={onClick}
      className={cn(
        'flex h-8 items-center gap-2.5 rounded-md border border-dashed border-rail-line px-2.5 text-left text-body text-rail-muted transition-colors',
        'hover:border-solid hover:border-accent-line hover:text-rail-foreground',
        collapsed && 'justify-center px-0',
      )}
    >
      <Plus aria-hidden="true" className="size-4 shrink-0" />
      {collapsed ? null : <span className="truncate">New App</span>}
    </button>
  );
}

function RailAppSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-8 items-center gap-2.5 px-2.5">
      <Skeleton className="size-[7px] shrink-0 rounded-full bg-rail-active" />
      <Skeleton className="h-3 w-24 bg-rail-active" />
    </div>
  );
}

/**
 * Polls faster while any App is mid-release. A failed read draws no rows and
 * says nothing.
 */
function useRailApps(): {
  readonly apps: readonly AppListItem[] | undefined;
  readonly loading: boolean;
} {
  const read = useRead([['listApps', {}]], (listed) =>
    listed?.[0].apps.some((app) => isInFlight(app.phase)) ? 3_000 : 20_000,
  );
  return {
    apps: read.type === 'success' ? read.value[0].apps : undefined,
    loading: read.type === 'loading',
  };
}

export function AppShell({
  path,
  principal,
  version = null,
  apps: appsProp,
  onNavigate,
  onSignOut,
  themeControl,
  children,
}: {
  readonly path: string;
  readonly principal: Principal;
  /** The server's `SPINDRIFT_VERSION`, or `null` when none is set. */
  readonly version?: string | null;
  /** Fetched in an effect when omitted, and a static render runs no effects. */
  readonly apps?: readonly AppListItem[];
  readonly onNavigate: (path: string) => void;
  readonly onSignOut: () => void;
  readonly themeControl: ReactNode;
  readonly children: ReactNode;
}) {
  // Also the server snapshot, since it reads `false` without a `window`. React
  // requires the third argument during a server render.
  const reconnecting = useSyncExternalStore(
    onConnectionChange,
    isReconnecting,
    isReconnecting,
  );
  const [collapsed, setCollapsed] = useState(railCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const fetchedApps = useRailApps();
  const apps = appsProp ?? fetchedApps.apps;
  const appsLoading = appsProp === undefined && fetchedApps.loading;

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      rememberRail(!current);
      return !current;
    });
  };

  const appEntries = (apps ?? []).slice(0, RAIL_APPS_CAP).map((app) => ({
    key: `apps:${app.id}`,
    roots: [`/apps/${app.id}`],
  }));
  const winner = activeKey(path, [
    { key: 'apps:all', roots: ['/apps'] },
    ...appEntries,
    ...WORKSPACE,
    ...DEVELOPER,
    FOOTER_SETTINGS,
  ]);
  const phoneWinner = activeKey(path, PHONE_NAV);

  return (
    <div
      className={cn(
        'min-h-dvh bg-background md:grid',
        collapsed
          ? 'md:grid-cols-[56px_minmax(0,1fr)]'
          : 'md:grid-cols-[240px_minmax(0,1fr)]',
      )}
    >
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rail-line bg-rail md:flex">
        <div className="flex h-12 shrink-0 items-center border-b border-rail-line px-2">
          {collapsed ? null : (
            <button
              type="button"
              aria-label={`${PRODUCT_NAME} overview`}
              onClick={() => onNavigate('/')}
              // `group` lets the wordmark's hover wink fire across this padding.
              className="group flex min-w-0 flex-1 items-center rounded-sm px-1.5 py-1 hover:bg-rail-active/60"
            >
              <Wordmark
                setting="rail"
                className="truncate text-rail-foreground"
              />
            </button>
          )}
          <RailToggle
            collapsed={collapsed}
            onToggle={toggleCollapsed}
            className={collapsed ? 'mx-auto' : undefined}
          />
        </div>

        <nav
          aria-label="Primary navigation"
          className="flex flex-1 flex-col gap-1 overflow-y-auto p-2"
        >
          <NewAppRow
            collapsed={collapsed}
            onClick={() => onNavigate('/apps/new')}
          />
          <RailRow
            collapsed={collapsed}
            label="Search"
            onClick={() => setPaletteOpen(true)}
            leading={<Search aria-hidden="true" className="size-4" />}
            trailing={
              <span className="ml-auto flex shrink-0 items-center gap-0.5">
                <Kbd>{metaKeyGlyph()}</Kbd>
                <Kbd>K</Kbd>
              </span>
            }
          />

          <RailGroup id="apps" label="Apps" collapsed={collapsed}>
            {appsLoading
              ? Array.from({ length: 4 }, (_, index) => (
                  <RailAppSkeleton key={index} />
                ))
              : (apps ?? [])
                  .slice(0, RAIL_APPS_CAP)
                  .map((app) => (
                    <RailRow
                      key={app.id}
                      collapsed={collapsed}
                      active={winner === `apps:${app.id}`}
                      label={app.name}
                      detail={
                        app.deployId === undefined
                          ? 'Never deployed'
                          : app.faulty
                            ? 'Faulty'
                            : deployPhaseWord(app.phase)
                      }
                      onClick={() => onNavigate(`/apps/${app.id}`)}
                      leading={<AppDot app={app} />}
                      labelClassName="font-mono"
                    />
                  ))}
            <RailRow
              collapsed={collapsed}
              active={winner === 'apps:all'}
              label="All apps"
              onClick={() => onNavigate('/apps')}
              leading={<Boxes aria-hidden="true" className="size-4" />}
              labelClassName="text-caption"
            />
          </RailGroup>

          <div aria-hidden="true" className="my-1 border-t border-rail-line" />

          <RailGroup id="workspace" label="Workspace" collapsed={collapsed}>
            {WORKSPACE.map(({ key, label, icon: Icon, path: destination }) => (
              <RailRow
                key={key}
                collapsed={collapsed}
                active={winner === key}
                label={label}
                onClick={() => onNavigate(destination)}
                leading={<Icon aria-hidden="true" className="size-4" />}
              />
            ))}
          </RailGroup>

          <div aria-hidden="true" className="my-1 border-t border-rail-line" />

          <RailGroup id="developer" label="Developer" collapsed={collapsed}>
            {DEVELOPER.map(({ key, label, icon: Icon, path: destination }) => (
              <RailRow
                key={key}
                collapsed={collapsed}
                active={winner === key}
                label={label}
                onClick={() => onNavigate(destination)}
                leading={<Icon aria-hidden="true" className="size-4" />}
              />
            ))}
          </RailGroup>
        </nav>

        <div className="shrink-0 border-t border-rail-line p-2">
          <div
            className={cn('flex items-center gap-1', collapsed && 'flex-col')}
          >
            <RailRow
              collapsed={collapsed}
              active={winner === FOOTER_SETTINGS.key}
              label={FOOTER_SETTINGS.label}
              onClick={() => onNavigate(FOOTER_SETTINGS.path)}
              leading={<Settings aria-hidden="true" className="size-4" />}
              className={collapsed ? undefined : 'flex-1'}
            />
            <div className={cn(collapsed && 'hidden')}>{themeControl}</div>
          </div>
        </div>
      </aside>

      <div className="relative min-w-0">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-4 border-b border-border bg-topbar/90 px-4 backdrop-blur sm:px-6">
          {/* The product's one flyover. Inside the sticky header, so the pass
              stays on screen however far the document has scrolled. */}
          <Roflcopter flyover />
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          <div className="ml-auto flex items-center gap-2">
            {/* The trigger shows on phones only; the rail has its own Search row. */}
            <CommandPalette
              onNavigate={onNavigate}
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              triggerClassName="md:hidden"
            />
            {/* Hidden only where an expanded rail's footer carries it. */}
            <div className={collapsed ? undefined : 'md:hidden'}>
              {themeControl}
            </div>
            <AccountMenu
              principal={principal}
              onNavigate={onNavigate}
              onSignOut={onSignOut}
            />
            <Button
              size="icon"
              variant="ghost"
              title="Sign out"
              aria-label="Sign out"
              className="md:hidden"
              onClick={onSignOut}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </header>
        {reconnecting ? (
          // A stalled stream looks like a quiet one, so the shell says when it
          // is retrying.
          <div
            role="status"
            className="flex items-center gap-2 border-b border-border bg-muted/60 px-4 py-1.5 text-xs text-muted-foreground sm:px-6"
          >
            <WifiOff aria-hidden="true" className="size-3.5 shrink-0" />
            <span>Disconnected, retrying…</span>
          </div>
        ) : null}
        <main className="min-w-0 pb-20 md:pb-0">{children}</main>
        {version ? (
          // Padded clear of the fixed phone bar, which would otherwise hide it.
          <footer className="px-4 pb-24 pt-2 text-[11px] text-muted-foreground sm:px-6 md:pb-3">
            <span className="font-mono" title={`Running ${version}`}>
              {PRODUCT_NAME} {version}
            </span>
          </footer>
        ) : null}
      </div>

      <nav
        aria-label="Primary navigation (compact)"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-7 border-t border-rail-line bg-rail/95 p-1.5 backdrop-blur md:hidden"
      >
        {PHONE_NAV.map(({ key, label, icon: Icon, path: destination }) => {
          const current = key === phoneWinner;
          return (
            <button
              key={key}
              type="button"
              title={label}
              aria-label={label}
              aria-current={current ? 'page' : undefined}
              onClick={() => onNavigate(destination)}
              className={cn(
                'group flex min-w-0 flex-col items-center justify-center gap-1 rounded-sm px-1 py-2 text-micro font-semibold tracking-wide transition-colors',
                current
                  ? 'bg-rail-active text-rail-foreground'
                  : 'text-rail-muted hover:bg-rail-active/60 hover:text-rail-foreground',
              )}
            >
              <Icon aria-hidden="true" className="size-[18px] shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Mounted once in the shell; `notify()` reaches it from anywhere. */}
      <ToastHost />
    </div>
  );
}
