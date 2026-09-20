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
 * One thing the rail or the phone bar can go to, and the roots that light it.
 *
 * `roots` is what {@link activeKey} scores against — the first of them is
 * *not* privileged, unlike `path`: a destination can be reached at one address
 * and lit by several, which is what lets Settings default to
 * `/settings/connections` on click while lighting for the whole of
 * `/settings`. That divergence is deliberate on Settings; on every other
 * entry `path` is one of its own `roots`, so clicking a row is what lights
 * it — `test/web/shell-chrome.test.tsx` pins that rule for the rest of them.
 */
interface RailDestination {
  readonly key: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly path: string;
  readonly roots: readonly string[];
}

/**
 * The rail's Workspace group.
 *
 * Apps is not in it — §18's live list belongs beside a status dot, not behind
 * a nav icon, so it is its own group below. Targets is: it navigates to its
 * own `/targets` — which `Screen` (`app.tsx`) resolves to the Connections
 * section of Settings, the same way `/repos` and `/storage` do — rather than
 * to `/settings/connections` directly, so a click lands on one of Targets'
 * own `roots` and lights the row that was just pressed instead of Settings'
 * footer entry.
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

/**
 * The rail's Developer group. CLI and SDK have no screen in this console, so
 * MCP — where an agent token is minted (`views/auth/agent-tokens.tsx`) — is
 * the only entry.
 */
export const DEVELOPER: readonly RailDestination[] = [
  {
    key: 'mcp',
    label: 'MCP',
    icon: Bot,
    path: '/settings/identity',
    roots: ['/settings/identity'],
  },
];

/** The rail's footer entry — everything else `/settings` names. */
export const FOOTER_SETTINGS: RailDestination = {
  key: 'settings',
  label: 'Settings',
  icon: Settings,
  path: '/settings/connections',
  roots: ['/settings'],
};

/**
 * The phone bar's own seven, independent of the rail's groups: the mock's
 * Apps group has no room on a bottom bar, so it collapses to the one link
 * that already reaches all of it, and Targets/MCP fold back into Settings —
 * a phone reaches those from Connections' own tabs once it is there.
 * Datastores and Functions keep their own tap targets rather than folding the
 * same way: neither is a section of Settings for a phone to reach that way,
 * and each is the *only* rail-shaped path to its list — the tab strip a
 * detail screen's own back button lands on is not one.
 */
/** Exported for `test/web/shell-chrome.test.tsx`'s own coverage of the phone bar. */
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

/** How many of the installation's Apps the rail shows before "All apps" takes over. */
const RAIL_APPS_CAP = 8;

/**
 * Where the rail's width is remembered, beside the theme key.
 *
 * It is a preference about the reader's screen, not about this installation, so
 * it belongs in the same store `theme.ts` uses and travels with the browser
 * rather than the session.
 */
const RAIL_KEY = 'spindrift.rail';

/**
 * Read once, in a lazy initialiser, and guarded: this component is rendered to
 * static markup by three test files, and `localStorage` is a browser global
 * that a server render does not have. An unreadable preference is "expanded",
 * which is the state that shows the labels this rail exists to add.
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
    // A blocked or full store loses the preference for this visit and nothing
    // else. Refusing to navigate because a width could not be written would be
    // the worse failure.
  }
}

function under(path: string, root: string): boolean {
  if (root === '/') return path === '/';
  return path === root || path.startsWith(`${root}/`);
}

/**
 * How specifically one candidate's roots match a path — the length of the
 * longest root that does, or `-1` for none. Every root here is a literal path
 * prefix, so the longer one that still matches is always the more specific
 * claim about where the reader is.
 */
function specificity(path: string, roots: readonly string[]): number {
  let best = -1;
  for (const root of roots) {
    if (under(path, root)) best = Math.max(best, root.length);
  }
  return best;
}

/**
 * Which one candidate, of a set that may make competing claims about the same
 * path, actually lights — exactly one, or none.
 *
 * `/settings/identity` matches both a bare `/settings` root and MCP's own
 * `/settings/identity` root; `/targets` matches only Targets. The rule is the
 * same either way: **the most specific root wins**, so a destination naming
 * the whole of Settings never outshines one naming a section of it, and a
 * legacy alias root never lights the entry its target screen also answers to
 * directly.
 *
 * Exported for `test/web/shell-chrome.test.tsx`, which pins this rule against
 * the exact aliasing this file's own comments describe rather than against
 * rendered markup.
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
 * Who is signed in, and the two things they can do about it.
 *
 * This was a `<span title={displayName}>` in the bottom of the rail: not
 * focusable, not reachable by keyboard, and announcing the operator's name only
 * to a pointer that hovered over it for a second. The name is the one piece of
 * chrome that answers "am I about to press Deploy on production as the wrong
 * principal", so it is now a real control.
 *
 * A native `popover`, which means no state, no outside-click handler and no
 * focus trap of our own: the platform puts it in the top layer, closes it on
 * Escape and on a press elsewhere, and moves focus for us. That is the whole
 * reason not to reach for a menu component here.
 *
 * It lives in the header rather than the rail, because the rail is `md:flex` —
 * an account menu only signed-in operators on wide screens can reach is a
 * sign-out button that does not exist on a phone.
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

/** The collapse/expand control, shared by its header spot in both rail states. */
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
 * One interactive row of the rail — an icon or a dot, a label the collapsed
 * rail drops to a tooltip, and the pink leading-edge marker when it is the
 * one thing on the path.
 *
 * A real `<button>` always, per §"the rail" of this component's own brief: a
 * row that only looks like a control is a control a keyboard cannot reach.
 *
 * `detail` names, in words, whatever a leading dot only encodes in colour —
 * an App row's live/building/failed/idle state, today. The dot itself stays
 * `aria-hidden`; colour alone is never this row's only answer to "what is
 * this", and a screen reader gets nothing from a dot even when a sighted
 * reader can tell two hues apart.
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
 * A labelled group of rows — the eyebrow names the list for a screen reader
 * exactly as it names it for a sighted one, `aria-labelledby` rather than a
 * repeated `aria-label`, so the two can never drift apart.
 *
 * The heading stays in the tree when the rail collapses rather than being
 * dropped: the group still needs a name, only the sighted label does not fit.
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

/** The dashed-border row that starts a new App, solid and pink-lined on hover. */
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

/** Four rows the width of a name, standing in for the Apps group while it loads. */
function RailAppSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-8 items-center gap-2.5 px-2.5">
      <Skeleton className="size-[7px] shrink-0 rounded-full bg-rail-active" />
      <Skeleton className="h-3 w-24 bg-rail-active" />
    </div>
  );
}

/**
 * The Apps group's live list, over the same cadence `views/apps/list.tsx`
 * polls on: a rail row for an App mid-release is exactly the row that needs
 * to notice when it lands.
 *
 * A failed read is silent by design — `type: 'error'` and `type: 'loading'`
 * both resolve to "no rows yet" here, because the rail's job is to draw
 * without the list, never to explain why one screen's fetch did not answer.
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
  /**
   * What the answering process is running (`SPINDRIFT_VERSION`), or `null`
   * where the deployment states nothing. Digest-pinned delivery rolls pods
   * without a version anybody typed, so this is the one line that says which
   * image the browser is talking to.
   */
  readonly version?: string | null;
  /**
   * The rail's Apps group, when a caller already has it. Fetched with
   * {@link useRailApps} otherwise — the fetch lives in an effect, which does
   * not run under `renderToStaticMarkup`, so the three tests that render this
   * shell without a network stay network-free by simply not passing this,
   * rather than by this component special-casing a test environment.
   */
  readonly apps?: readonly AppListItem[];
  readonly onNavigate: (path: string) => void;
  readonly onSignOut: () => void;
  readonly themeControl: ReactNode;
  readonly children: ReactNode;
}) {
  // `isReconnecting` doubles as its own server snapshot: unlike
  // `router.ts`'s hash, this store's state is `Set.size`, which reads the
  // same — always `false` — with or without a `window`. React still requires
  // the third argument from any `useSyncExternalStore` reached during a
  // server render, so it is passed rather than left to the default.
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
              // `group` is what lets the mark's own hover glitch
              // (`components/wordmark.tsx`) reach past the padding around it —
              // the wink is a property of pointing at the mark, not just of the
              // span it happens to be drawn in.
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
          {/* One instance for the whole product, silent until a Deploy this
              tab is watching lands on LIVE (`views/apps/deploy-detail.tsx`
              calls `flyover()`). A child of this `sticky` header rather than
              of the column below — this column is not its own scroller, the
              document is, so anchoring the pass to something that scrolls
              away with it would fly it off-screen for anyone scrolled past
              the header when a deploy lands, which is the normal posture for
              watching one. `sticky` is a positioned value, so the header is
              already this absolutely-positioned pass's containing block with
              no `relative` of its own needed — it just never clips it, since
              the pass carries its own `overflow-hidden`. */}
          <Roflcopter flyover />
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          <div className="ml-auto flex items-center gap-2">
            {/* The rail carries its own Search row once it is on screen, so
                this trigger — and the catalogue read behind it — only needs
                to exist for a reader on a phone, where the rail is hidden. */}
            <CommandPalette
              onNavigate={onNavigate}
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              triggerClassName="md:hidden"
            />
            {/* The footer below carries this control once the rail is on
                screen and open — `md:hidden` stands down only then, so a
                collapsed rail (which drops its own copy for width) does not
                strand the reader with no way to reach it at all. */}
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
          // Silent forever was the bug (`stream-client.ts`'s header explains
          // the retry loop this reports on): a live pane that has stopped
          // updating and says nothing looks identical to one with nothing new
          // to show. This is the one place every screen with a stream passes
          // through, which is why it renders here rather than on each screen
          // that could show it.
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
          // Below the phone bar's clearance on small screens, so the line is
          // reachable rather than hidden behind the fixed navigation.
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

      {/* Mounted once, here, because this is the one component every screen in
          the product passes through — the same argument the two banners above
          are already made on. `notify()` reaches it from anywhere. */}
      <ToastHost />
    </div>
  );
}
