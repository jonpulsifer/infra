/**
 * The shell, and the client's whole route table.
 *
 * §18's surfaces are the three screens below; everything else here is chrome
 * that exists to reach them. The scenario switcher at the foot of each screen
 * is **demo scaffolding** — it drives the placeholder data in `demo/` and comes
 * out with it, which is why it is one component in one place rather than a prop
 * threaded through the views.
 */
import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import { readSession, signOut } from './auth-client.ts';
import { command } from './client.ts';
import {
  DEPLOY_SCENARIO_NAMES,
  DEPLOY_SCENARIOS,
  type DeployScenarioName,
  INITIAL_DRAFT,
  LINKED_REPOS,
  REPOSITORY_OPTIONS,
  TARGET_LIST,
  TARGET_OPTIONS,
  WORKSPACE_SCENARIO_NAMES,
  WORKSPACE_SCENARIOS,
  type WorkspaceScenarioName,
} from './demo/scenarios.ts';
import type { AppListItem } from './model.ts';
import { useRoute } from './router.ts';
import { type Theme, useTheme } from './theme.ts';
import { Button } from './ui/button.tsx';
import { Eyebrow } from './ui/card.tsx';
import { cn } from './ui/utils.ts';
import { DeployDetail } from './views/apps/deploy-detail.tsx';
import { AppList } from './views/apps/list.tsx';
import { NewApp } from './views/apps/new/index.tsx';
import { Workspace } from './views/apps/workspace.tsx';
import { Gate } from './views/auth/gate.tsx';
import { Settings } from './views/auth/settings.tsx';
import { RepositoryList } from './views/repos/list.tsx';
import { TargetList } from './views/targets/list.tsx';

const NAV = [
  { path: '/apps', label: 'Apps' },
  { path: '/targets', label: 'Targets' },
  { path: '/repos', label: 'Repos' },
  { path: '/apps/new', label: 'New App' },
  { path: '/settings', label: 'Settings' },
] as const;

/**
 * Nobody, somebody, or not asked yet.
 *
 * Three states rather than a nullable principal, because the third is real and
 * short: between mount and the first answer the shell knows nothing, and
 * rendering the front door during it would flash a sign-in screen at an
 * operator who is already signed in.
 */
type Gatekeeping =
  | { readonly state: 'asking' }
  | {
      readonly state: 'anonymous';
      readonly claimed: boolean;
      readonly gatewayUnlinked: boolean;
    }
  | { readonly state: 'signed-in'; readonly principal: Principal };

export function App() {
  const route = useRoute();
  const [gate, setGate] = useState<Gatekeeping>({ state: 'asking' });

  useEffect(() => {
    let live = true;
    readSession()
      .then(({ principal, claimed, gatewayUnlinked }) => {
        if (!live) return;
        setGate(
          principal === null
            ? { state: 'anonymous', claimed, gatewayUnlinked }
            : { state: 'signed-in', principal },
        );
      })
      .catch(() => {
        if (live) {
          setGate({
            state: 'anonymous',
            claimed: false,
            gatewayUnlinked: false,
          });
        }
      });
    return () => {
      live = false;
    };
  }, []);

  if (gate.state === 'asking') return null;

  if (gate.state === 'anonymous') {
    return (
      <Gate
        claimed={gate.claimed}
        gatewayUnlinked={gate.gatewayUnlinked}
        onSignedIn={(principal) => setGate({ state: 'signed-in', principal })}
      />
    );
  }

  return (
    <div className="min-h-dvh">
      <TopBar
        path={route.path}
        onNavigate={route.navigate}
        principal={gate.principal}
        onSignOut={() => {
          void signOut().then(() =>
            setGate({
              state: 'anonymous',
              claimed: true,
              gatewayUnlinked: false,
            }),
          );
        }}
      />
      <Screen path={route.path} onNavigate={route.navigate} />
    </div>
  );
}

function Screen({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  if (path.startsWith('/settings')) return <Settings />;
  if (path.startsWith('/apps/new')) {
    return (
      <NewApp
        initialDraft={INITIAL_DRAFT}
        targets={TARGET_OPTIONS}
        repos={REPOSITORY_OPTIONS}
      />
    );
  }
  if (path.startsWith('/targets')) return <TargetList targets={TARGET_LIST} />;
  if (path.startsWith('/repos')) return <RepositoryList repos={LINKED_REPOS} />;
  if (path.startsWith('/deploys')) return <DeployScreen />;
  if (path === '/apps' || path === '')
    return <AppsScreen onNavigate={onNavigate} />;
  return <WorkspaceScreen />;
}

function AppsScreen({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; apps: readonly AppListItem[] }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    command('listApps', {})
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ type: 'success', apps: result.value.apps });
        } else {
          setState({ type: 'error', message: result.failure.message });
        }
      })
      .catch((e: unknown) => {
        if (!live) return;
        setState({
          type: 'error',
          message: e instanceof Error ? e.message : 'Server failure',
        });
      });
    return () => {
      live = false;
    };
  }, []);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading apps...
        </p>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load apps</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return <AppList apps={state.apps} onNavigate={onNavigate} />;
}

function TopBar({
  path,
  onNavigate,
  principal,
  onSignOut,
}: {
  path: string;
  onNavigate: (path: string) => void;
  principal: Principal;
  onSignOut: () => void;
}) {
  return (
    <header className="flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-border bg-card px-5 py-3">
      <span className="font-mono text-sm font-bold tracking-[0.18em]">
        SPINDRIFT
      </span>
      <nav className="flex gap-1">
        {NAV.map((item) => (
          <button
            key={item.path}
            type="button"
            onClick={() => onNavigate(item.path)}
            aria-current={path === item.path ? 'page' : undefined}
            className={cn(
              'rounded-md px-2.5 py-1.5 text-sm',
              path === item.path
                ? 'bg-secondary font-medium text-foreground'
                : 'text-subtle hover:text-foreground',
            )}
          >
            {item.label}
          </button>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-3">
        <ThemeToggle />
        <span className="text-sm text-subtle">{principal.displayName}</span>
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
  );
}

const THEMES = [
  { id: 'system', icon: Monitor, label: 'Follow the system theme' },
  { id: 'light', icon: Sun, label: 'Light theme' },
  { id: 'dark', icon: Moon, label: 'Dark theme' },
] as const satisfies readonly { id: Theme; icon: typeof Sun; label: string }[];

function ThemeToggle() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="flex rounded-md border border-border">
      {THEMES.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          title={label}
          aria-label={label}
          aria-pressed={theme === id}
          onClick={() => setTheme(id)}
          className={cn(
            'px-2 py-1.5 first:rounded-l-md last:rounded-r-md',
            theme === id
              ? 'bg-secondary text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon aria-hidden="true" className="size-4" />
        </button>
      ))}
    </div>
  );
}

/**
 * The switcher under a demo screen.
 *
 * It names each state in words rather than numbering them: the six deploy
 * scenarios are six things §6 says can happen, and "imageUnpullable" teaches
 * something that "4" does not.
 */
function ScenarioBar<Name extends string>({
  names,
  active,
  onSelect,
}: {
  names: readonly Name[];
  active: Name;
  onSelect: (name: Name) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center gap-2 px-5 pb-8">
      <Eyebrow className="mr-1">Placeholder state</Eyebrow>
      {names.map((name) => (
        <Button
          key={name}
          size="sm"
          variant={name === active ? 'default' : 'outline'}
          onClick={() => onSelect(name)}
        >
          {name}
        </Button>
      ))}
    </div>
  );
}

/**
 * Scenario selection lives in the hash so a link to a state is shareable — the
 * thing a demo is actually for.
 */
function useScenario<Name extends string>(
  names: readonly Name[],
  fallback: Name,
): [Name, (name: Name) => void] {
  const route = useRoute();
  const [, base = '', chosen] = route.path.split('/');
  const active = names.includes(chosen as Name) ? (chosen as Name) : fallback;
  return [active, (name: Name) => route.navigate(`/${base}/${name}`)];
}

function DeployScreen() {
  const [scenario, setScenario] = useScenario(
    DEPLOY_SCENARIO_NAMES,
    'live' satisfies DeployScenarioName,
  );

  return (
    <>
      <DeployDetail view={DEPLOY_SCENARIOS[scenario]} />
      <ScenarioBar
        names={DEPLOY_SCENARIO_NAMES}
        active={scenario}
        onSelect={setScenario}
      />
    </>
  );
}

function WorkspaceScreen() {
  const [scenario, setScenario] = useScenario(
    WORKSPACE_SCENARIO_NAMES,
    'service' satisfies WorkspaceScenarioName,
  );

  return (
    <>
      <Workspace view={WORKSPACE_SCENARIOS[scenario]} />
      <ScenarioBar
        names={WORKSPACE_SCENARIO_NAMES}
        active={scenario}
        onSelect={setScenario}
      />
    </>
  );
}
