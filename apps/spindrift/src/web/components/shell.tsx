import {
  Boxes,
  Database,
  Hammer,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Rocket,
  Settings,
  WifiOff,
  Zap,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState, useSyncExternalStore } from 'react';
import type { Principal } from '../../commands/types.ts';
import { isReconnecting, onConnectionChange } from '../connection-status.ts';
import { Button } from '../ui/button.tsx';
import { ToastHost } from '../ui/toast.tsx';
import { cn } from '../ui/utils.ts';
import { Breadcrumbs } from './breadcrumbs.tsx';
import { CommandPalette } from './command-palette.tsx';

/**
 * The rail, and the one grouping in it.
 *
 * **Supply chain is one entry over three roots.** Sources, Builds and Artifacts
 * are §2's chain read left to right — Source + Build = Artifact — and a rail
 * that listed all three would spend half its height on the machinery behind one
 * running App. They share an entry and separate with a tab strip on the screen.
 *
 * Deploy is not in that group. It is the act that puts something in front of
 * users, and §18's "the running app is the product, the pipeline is only how it
 * got there" is the whole reason it does not read as the chain's last stage.
 *
 * Datastores is not in it either, and for a different reason than Deploy's:
 * §11 never puts a Datastore on §2's chain at all — it is never a Source, a
 * Build or an Artifact, so there is no stage to fold it into.
 *
 * `roots` is what the entry lights up for; the first of them is where it goes.
 */
const NAVIGATION = [
  { path: '/', label: 'Overview', icon: LayoutDashboard, roots: ['/'] },
  { path: '/apps', label: 'Apps', icon: Boxes, roots: ['/apps'] },
  {
    path: '/builds',
    label: 'Supply chain',
    icon: Hammer,
    roots: ['/builds', '/sources', '/artifacts'],
  },
  { path: '/deploys', label: 'Deploys', icon: Rocket, roots: ['/deploys'] },
  {
    path: '/datastores',
    label: 'Datastores',
    icon: Database,
    roots: ['/datastores'],
  },
  {
    path: '/functions',
    label: 'Functions',
    icon: Zap,
    roots: ['/functions'],
  },
  {
    path: '/settings/connections',
    label: 'Settings',
    icon: Settings,
    // The three roots that used to be their own screens and are now sections
    // of Connections.
    roots: ['/settings', '/targets', '/repos', '/storage'],
  },
] as const;

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

function active(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => under(path, root));
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
        className="fixed inset-auto right-4 top-[68px] m-0 w-56 rounded-sm border border-border bg-card p-1.5 shadow-panel"
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

export function AppShell({
  path,
  principal,
  version = null,
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

  /**
   * One array, two navigations.
   *
   * The rail and the phone bar have always rendered the same entries; what they
   * did not have was different names. Two `<nav aria-label="Primary
   * navigation">` landmarks in one document give a screen-reader's landmark
   * list two identical rows and no way to tell which one it is jumping to, so
   * the compact one says so.
   */
  const navigation = (compact: boolean) =>
    NAVIGATION.map(({ path: destination, label, icon: Icon, roots }) => {
      const current = active(path, roots);
      const stacked = compact || collapsed;
      return (
        <button
          key={destination}
          type="button"
          title={label}
          aria-label={label}
          aria-current={current ? 'page' : undefined}
          onClick={() => onNavigate(destination)}
          className={cn(
            'group flex min-w-0 items-center gap-2.5 rounded-sm transition-colors',
            stacked
              ? 'flex-col justify-center gap-1 px-2 py-2 text-micro font-semibold tracking-wide'
              : 'px-2.5 py-2 text-body font-medium',
            current
              ? 'bg-rail-active text-rail-foreground'
              : 'text-rail-muted hover:bg-rail-active/60 hover:text-rail-foreground',
          )}
        >
          <Icon aria-hidden="true" className="size-[18px] shrink-0" />
          <span className={cn(!stacked && 'truncate')}>{label}</span>
        </button>
      );
    });

  return (
    <div
      className={cn(
        'min-h-dvh bg-background md:grid',
        collapsed
          ? 'md:grid-cols-[76px_minmax(0,1fr)]'
          : 'md:grid-cols-[240px_minmax(0,1fr)]',
      )}
    >
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rail-line bg-rail p-2 md:flex">
        <button
          type="button"
          aria-label="Spindrift overview"
          onClick={() => onNavigate('/')}
          className={cn(
            'mb-4 flex h-10 items-center gap-2.5 rounded-sm',
            collapsed ? 'mx-auto w-10 justify-center' : 'px-2.5',
          )}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-sm bg-primary font-mono text-base font-black text-primary-foreground">
            S
          </span>
          {collapsed ? null : (
            <span className="truncate font-mono text-body font-bold tracking-eyebrow text-rail-foreground">
              SPINDRIFT
            </span>
          )}
        </button>
        <nav aria-label="Primary navigation" className="flex flex-col gap-1">
          {navigation(false)}
        </nav>
        <div className="mt-auto border-t border-rail-line pt-3">
          <button
            type="button"
            aria-pressed={collapsed}
            aria-label={collapsed ? 'Expand the rail' : 'Collapse the rail'}
            title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
            onClick={() => {
              setCollapsed((current) => {
                rememberRail(!current);
                return !current;
              });
            }}
            className={cn(
              'flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2 text-body text-rail-muted hover:bg-rail-active/60 hover:text-rail-foreground',
              collapsed && 'justify-center px-2',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-[18px]" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-[18px]" />
            )}
            {collapsed ? null : <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-[72px] items-center gap-4 border-b border-border bg-topbar/90 px-4 backdrop-blur sm:px-6">
          <Breadcrumbs path={path} onNavigate={onNavigate} />
          <div className="ml-auto flex items-center gap-2">
            <CommandPalette onNavigate={onNavigate} />
            {themeControl}
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
              Spindrift {version}
            </span>
          </footer>
        ) : null}
      </div>

      <nav
        aria-label="Primary navigation (compact)"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-6 border-t border-rail-line bg-rail/95 p-1.5 backdrop-blur md:hidden"
      >
        {navigation(true)}
      </nav>

      {/* Mounted once, here, because this is the one component every screen in
          the product passes through — the same argument the two banners above
          are already made on. `notify()` reaches it from anywhere. */}
      <ToastHost />
    </div>
  );
}
