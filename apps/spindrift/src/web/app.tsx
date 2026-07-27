/**
 * The shell, and the client's whole route table.
 *
 * §18's surfaces are the three screens below; everything else here is chrome
 * that exists to reach them. The scenario switcher at the foot of each screen
 * is **demo scaffolding** — it drives the placeholder data in `demo/` and comes
 * out with it, which is why it is one component in one place rather than a prop
 * threaded through the views.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import {
  DEPLOY_SCENARIO_NAMES,
  DEPLOY_SCENARIOS,
  type DeployScenarioName,
  INITIAL_DRAFT,
  TARGET_OPTIONS,
  WORKSPACE_SCENARIO_NAMES,
  WORKSPACE_SCENARIOS,
  type WorkspaceScenarioName,
} from './demo/scenarios.ts';
import { useRoute } from './router.ts';
import { type Theme, useTheme } from './theme.ts';
import { Button } from './ui/button.tsx';
import { Eyebrow } from './ui/card.tsx';
import { cn } from './ui/utils.ts';
import { DeployDetail } from './views/apps/deploy-detail.tsx';
import { NewApp } from './views/apps/new/index.tsx';
import { Workspace } from './views/apps/workspace.tsx';

const NAV = [
  { path: '/apps', label: 'Apps' },
  { path: '/deploys', label: 'Deploys' },
  { path: '/apps/new', label: 'New App' },
] as const;

export function App() {
  const route = useRoute();

  return (
    <div className="min-h-dvh">
      <TopBar path={route.path} onNavigate={route.navigate} />
      <Screen path={route.path} />
    </div>
  );
}

function Screen({ path }: { path: string }) {
  if (path.startsWith('/apps/new')) {
    return <NewApp initialDraft={INITIAL_DRAFT} targets={TARGET_OPTIONS} />;
  }
  if (path.startsWith('/deploys')) return <DeployScreen />;
  return <WorkspaceScreen />;
}

function TopBar({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
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
