/**
 * The shell and the client's route table: the sign-in gate, the onboarding
 * gate, and the screen each path names.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import { readSession, signOut } from './auth-client.ts';
import { pageTitle } from './brand.ts';
import { command } from './client.ts';
import { AppShell } from './components/shell.tsx';
import { useRoute } from './router.ts';
import { SESSION_EXPIRED_EVENT } from './session-events.ts';
import { type Theme, useTheme } from './theme.ts';
import { cn } from './ui/utils.ts';
import { BuildScreen, DeployScreen } from './views/apps/deploy-detail.tsx';
import { AppsScreen } from './views/apps/list.tsx';
import { NewAppScreen } from './views/apps/new/index.tsx';
import { WorkspaceScreen } from './views/apps/workspace.tsx';
import { Gate } from './views/auth/gate.tsx';
import { Onboarding } from './views/auth/onboarding.tsx';
import { FunctionScreen } from './views/functions/editor.tsx';
import { FunctionsScreen } from './views/functions/list.tsx';
import { DatastoreScreen } from './views/operations/datastore-detail.tsx';
import { DatastoresScreen } from './views/operations/datastores.tsx';
import { DeploysScreen } from './views/operations/deploys.tsx';
import { OverviewScreen } from './views/operations/overview.tsx';
import { SettingsScreen } from './views/settings/layout.tsx';
import { ArtifactsScreen } from './views/supply-chain/artifacts.tsx';
import { BuildsScreen } from './views/supply-chain/builds.tsx';
import { SourcesScreen } from './views/supply-chain/sources.tsx';

type Gatekeeping =
  | { readonly state: 'asking' }
  | {
      readonly state: 'anonymous';
      readonly claimed: boolean;
      readonly gatewayUnlinked: boolean;
    }
  | { readonly state: 'signed-in'; readonly principal: Principal };

/**
 * `asking` keeps the product from flashing up before onboarding replaces it.
 */
export type Configuration =
  | { readonly state: 'asking' }
  | { readonly state: 'unconfigured'; readonly manifest: unknown }
  | {
      readonly state: 'configured';
    };

// A timeout renders the product even on an unconfigured installation, so this
// only bounds a hang.
const ASK_TIMEOUT_MS = 10_000;

export function App() {
  const route = useRoute();
  const [gate, setGate] = useState<Gatekeeping>({ state: 'asking' });
  const [installation, setInstallation] = useState<Configuration>({
    state: 'asking',
  });
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    document.title = titleOf(route.path);
  }, [route.path]);

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

  // A transport raises this when the session expires mid-visit. The
  // installation stays claimed and its Gateway linked.
  useEffect(() => {
    const onExpired = () =>
      setGate({ state: 'anonymous', claimed: true, gatewayUnlinked: false });
    addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, []);

  // Asked only once signed in, so an anonymous load never draws a 401.
  useEffect(() => {
    if (gate.state !== 'signed-in') {
      // Reset on sign-out, so the next session never inherits this answer.
      setInstallation({ state: 'asking' });
      return;
    }
    let live = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    // A request held by a proxy or a rolling pod hangs without rejecting. A
    // failed or hung read shows the product, since onboarding would replace
    // the whole app on a guess.
    Promise.race([
      command('getInstallationManifest', {}),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
      }),
    ])
      .then((result) => {
        if (!live) return;
        if (result?.ok) setVersion(result.value.version);
        setInstallation(
          result?.ok && !result.value.configured
            ? { state: 'unconfigured', manifest: result.value.manifest }
            : { state: 'configured' },
        );
      })
      .catch(() => {
        if (live) {
          setInstallation({ state: 'configured' });
        }
      })
      .finally(() => clearTimeout(deadline));
    return () => {
      live = false;
      clearTimeout(deadline);
    };
  }, [gate.state]);

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
    <SignedIn
      principal={gate.principal}
      installation={installation}
      version={version}
      path={route.path}
      onNavigate={route.navigate}
      onConfigured={() => setInstallation({ state: 'configured' })}
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
  );
}

/**
 * Onboarding replaces the whole product until the installation is configured.
 * Exported so tests exercise these branches.
 */
export function SignedIn({
  principal,
  installation,
  version = null,
  path,
  onNavigate,
  onConfigured,
  onSignOut,
}: {
  readonly principal: Principal;
  readonly installation: Configuration;
  readonly version?: string | null;
  readonly path: string;
  onNavigate(path: string): void;
  onConfigured(): void;
  onSignOut(): void;
}) {
  if (installation.state === 'asking') return null;

  if (installation.state === 'unconfigured') {
    return (
      <Onboarding
        initial={installation.manifest}
        onDone={(next) => {
          onConfigured();
          if (next !== null) onNavigate(next);
        }}
      />
    );
  }

  return (
    <AppShell
      path={path}
      onNavigate={onNavigate}
      principal={principal}
      version={version}
      themeControl={<ThemeToggle />}
      onSignOut={onSignOut}
    >
      <Screen path={path} onNavigate={onNavigate} />
    </AppShell>
  );
}

/**
 * Mirrors {@link Screen} branch for branch, from the path alone, so a tab is
 * titled before any fetch returns.
 */
export function titleOf(path: string): string {
  if (path.startsWith('/settings')) return pageTitle('Settings');
  if (
    path.startsWith('/targets') ||
    path.startsWith('/repos') ||
    path.startsWith('/storage')
  )
    return pageTitle('Settings');
  if (path.startsWith('/sources')) return pageTitle('Sources');
  if (path.startsWith('/artifacts')) return pageTitle('Artifacts');
  // The id in the path is a uuid, which no reader wants as a title.
  if (path.startsWith('/datastores')) return pageTitle('Datastores');
  if (path.startsWith('/functions')) return pageTitle('Functions');
  if (path.startsWith('/apps/new')) return pageTitle('New App');
  if (path.startsWith('/deploys')) {
    const deployId = path.replace(/^\/deploys\/?/, '');
    return deployId ? pageTitle(`Deploy #${deployId}`) : pageTitle('Deploys');
  }
  if (path.startsWith('/builds')) {
    const buildId = path.replace(/^\/builds\/?/, '');
    return buildId ? pageTitle(`Build #${buildId}`) : pageTitle('Builds');
  }
  if (path === '/' || path === '') return pageTitle();
  if (path === '/apps') return pageTitle('Apps');
  const appName = path.replace(/^\/apps\//, '').replace(/^\//, '');
  return pageTitle(appName);
}

/**
 * A screen that names one object is keyed on its id, so switching objects
 * remounts it: no state carries over, and cleanup closes the old fetch.
 */
export function Screen({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  if (path.startsWith('/settings'))
    return <SettingsScreen path={path} onNavigate={onNavigate} />;
  // Targets, repos and storage are all connections.
  if (
    path.startsWith('/targets') ||
    path.startsWith('/repos') ||
    path.startsWith('/storage')
  )
    return (
      <SettingsScreen path="/settings/connections" onNavigate={onNavigate} />
    );
  if (path.startsWith('/sources'))
    return <SourcesScreen onNavigate={onNavigate} />;
  if (path.startsWith('/artifacts'))
    return <ArtifactsScreen onNavigate={onNavigate} />;
  if (path.startsWith('/datastores')) {
    const datastoreId = path.replace(/^\/datastores\/?/, '');
    return datastoreId ? (
      <DatastoreScreen
        key={datastoreId}
        datastoreId={datastoreId}
        onNavigate={onNavigate}
      />
    ) : (
      <DatastoresScreen onNavigate={onNavigate} />
    );
  }
  if (path.startsWith('/functions')) {
    const name = path.replace(/^\/functions\/?/, '') || null;
    if (name === 'new') {
      return <FunctionScreen key="new" name={null} onNavigate={onNavigate} />;
    }
    return name ? (
      <FunctionScreen key={name} name={name} onNavigate={onNavigate} />
    ) : (
      <FunctionsScreen onNavigate={onNavigate} />
    );
  }
  // Keyed on the route, because the path gains the draft id once the draft
  // starts. NewAppScreen keys each loaded draft itself.
  if (path.startsWith('/apps/new')) {
    const draftId = path.replace(/^\/apps\/new\/?/, '') || null;
    return (
      <NewAppScreen key="apps-new" draftId={draftId} onNavigate={onNavigate} />
    );
  }
  if (path.startsWith('/deploys')) {
    const deployId = path.replace(/^\/deploys\/?/, '');
    return deployId ? (
      <DeployScreen
        key={deployId}
        deployId={deployId}
        onNavigate={onNavigate}
      />
    ) : (
      <DeploysScreen onNavigate={onNavigate} />
    );
  }
  if (path.startsWith('/builds')) {
    const buildId = path.replace(/^\/builds\/?/, '');
    return buildId ? (
      <BuildScreen key={buildId} buildId={buildId} onNavigate={onNavigate} />
    ) : (
      <BuildsScreen onNavigate={onNavigate} />
    );
  }
  if (path === '/' || path === '')
    return <OverviewScreen onNavigate={onNavigate} />;
  if (path === '/apps') return <AppsScreen onNavigate={onNavigate} />;
  if (path.startsWith('/apps/')) {
    const appName = path.replace(/^\/apps\//, '');
    return (
      <WorkspaceScreen
        key={appName}
        appName={appName}
        onNavigate={onNavigate}
      />
    );
  }
  // Any other single segment is an App name, so every other route matches first.
  const appName = path.slice(1);
  return (
    <WorkspaceScreen key={appName} appName={appName} onNavigate={onNavigate} />
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
