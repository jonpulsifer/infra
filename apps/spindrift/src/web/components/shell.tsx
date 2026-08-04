import {
  AlertTriangle,
  Boxes,
  Hammer,
  LayoutDashboard,
  LogOut,
  Rocket,
  Settings,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { Principal } from '../../commands/types.ts';
import { Button } from '../ui/button.tsx';
import { cn } from '../ui/utils.ts';

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
    path: '/settings/connections',
    label: 'Settings',
    icon: Settings,
    // The three roots that used to be their own screens and are now sections
    // of Connections.
    roots: ['/settings', '/targets', '/repos', '/storage'],
  },
] as const;

function under(path: string, root: string): boolean {
  if (root === '/') return path === '/';
  return path === root || path.startsWith(`${root}/`);
}

function active(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => under(path, root));
}

function title(path: string): string {
  if (path === '/') return 'Overview';
  const segment = path.split('/').filter(Boolean)[0];
  if (!segment) return 'Overview';
  if (segment === 'targets' || segment === 'repos' || segment === 'storage') {
    return 'Settings';
  }
  return segment[0]!.toUpperCase() + segment.slice(1);
}

function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  return (
    parts.length > 1
      ? `${parts[0]![0]}${parts.at(-1)![0]}`
      : (parts[0]?.slice(0, 2) ?? 'OP')
  ).toUpperCase();
}

export function AppShell({
  path,
  principal,
  onNavigate,
  onSignOut,
  themeControl,
  declarationDivergence = [],
  children,
}: {
  readonly path: string;
  readonly principal: Principal;
  readonly onNavigate: (path: string) => void;
  readonly onSignOut: () => void;
  readonly themeControl: ReactNode;
  /**
   * Dotted paths where the mounted declaration disagrees with this
   * installation (`views/auth/installation.tsx` says why a value never rides
   * along with one). Optional and defaulted to `[]` so every existing caller
   * — none of which had an opinion about a declaration — keeps asserting
   * nothing about a fact it does not exercise.
   *
   * Rendered here, under the header rather than only on the Settings screen,
   * because this is the one component every screen in the product passes
   * through: an installation nobody opens Settings on otherwise never learns
   * a merge did not reach the row.
   */
  readonly declarationDivergence?: readonly string[];
  readonly children: ReactNode;
}) {
  const navigation = (
    <>
      {NAVIGATION.map(({ path: destination, label, icon: Icon, roots }) => {
        const current = active(path, roots);
        return (
          <button
            key={destination}
            type="button"
            title={label}
            aria-label={label}
            aria-current={current ? 'page' : undefined}
            onClick={() => onNavigate(destination)}
            className={cn(
              'group flex min-w-0 flex-col items-center justify-center gap-1 rounded-sm px-2 py-2 text-[9px] font-semibold tracking-wide transition-colors',
              current
                ? 'bg-rail-active text-rail-foreground'
                : 'text-rail-muted hover:bg-rail-active/60 hover:text-rail-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-[18px]" />
            <span>{label}</span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="min-h-dvh bg-background md:grid md:grid-cols-[76px_minmax(0,1fr)]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-rail-line bg-rail p-2 md:flex">
        <button
          type="button"
          aria-label="Spindrift overview"
          onClick={() => onNavigate('/')}
          className="mx-auto mb-4 grid size-10 place-items-center rounded-sm bg-primary font-mono text-base font-black text-primary-foreground"
        >
          S
        </button>
        <nav aria-label="Primary navigation" className="flex flex-col gap-1">
          {navigation}
        </nav>
        <div className="mt-auto flex flex-col items-center gap-2 border-t border-rail-line pt-3">
          <span
            title={principal.displayName}
            className="grid size-9 place-items-center rounded-full border border-rail-line bg-rail-active font-mono text-[11px] font-bold text-rail-foreground"
          >
            {initials(principal.displayName)}
          </span>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-30 flex h-[72px] items-center gap-4 border-b border-border bg-topbar/90 px-4 backdrop-blur sm:px-6">
          <div className="min-w-0">
            <p className="truncate font-mono text-[10px] font-bold tracking-[0.12em] text-muted-foreground">
              SPINDRIFT / <span className="text-foreground">{title(path)}</span>
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {themeControl}
            <span className="hidden max-w-48 truncate text-xs text-subtle lg:inline">
              {principal.displayName}
            </span>
            <Button
              size="icon"
              variant="ghost"
              title="Sign out"
              aria-label="Sign out"
              onClick={onSignOut}
            >
              <LogOut aria-hidden="true" />
            </Button>
          </div>
        </header>
        {declarationDivergence.length > 0 ? (
          <div
            role="alert"
            className="flex items-center gap-2 border-b border-warning/40 bg-warning-soft px-4 py-2 text-xs sm:px-6"
          >
            <AlertTriangle
              aria-hidden="true"
              className="size-3.5 shrink-0 text-warning"
            />
            <span>
              The mounted declaration no longer matches this installation.{' '}
              <button
                type="button"
                className="underline underline-offset-2 hover:no-underline"
                onClick={() => onNavigate('/settings/installation')}
              >
                Review it in Settings
              </button>
              .
            </span>
          </div>
        ) : null}
        <main className="min-w-0 pb-20 md:pb-0">{children}</main>
      </div>

      <nav
        aria-label="Primary navigation"
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-rail-line bg-rail/95 p-1.5 backdrop-blur md:hidden"
      >
        {navigation}
      </nav>
    </div>
  );
}
