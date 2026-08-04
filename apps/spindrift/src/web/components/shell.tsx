import {
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

const NAVIGATION = [
  { path: '/', label: 'Overview', icon: LayoutDashboard },
  { path: '/apps', label: 'Apps', icon: Boxes },
  { path: '/builds', label: 'Builds', icon: Hammer },
  { path: '/deploys', label: 'Deploys', icon: Rocket },
  { path: '/settings/connections', label: 'Settings', icon: Settings },
] as const;

function active(path: string, destination: string): boolean {
  if (destination === '/') return path === '/';
  const root = destination.split('/')[1];
  if (
    root === 'settings' &&
    ['/targets', '/repos', '/storage'].some(
      (legacy) => path === legacy || path.startsWith(`${legacy}/`),
    )
  ) {
    return true;
  }
  return path === `/${root}` || path.startsWith(`/${root}/`);
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
  children,
}: {
  readonly path: string;
  readonly principal: Principal;
  readonly onNavigate: (path: string) => void;
  readonly onSignOut: () => void;
  readonly themeControl: ReactNode;
  readonly children: ReactNode;
}) {
  const navigation = (
    <>
      {NAVIGATION.map(({ path: destination, label, icon: Icon }) => {
        const current = active(path, destination);
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
