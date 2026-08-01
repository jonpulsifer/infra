/**
 * The shell, and the client's whole route table.
 *
 * §18's surfaces are the three screens below; everything else here is chrome
 * that exists to reach them.
 */
import { LogOut, Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import { readSession, signOut } from './auth-client.ts';
import { command, type InputOf } from './client.ts';
import type {
  AppListItem,
  DeployView,
  LinkedRepoView,
  RepositoryConnectorView,
  RepositoryOptionView,
  TargetListItem,
  TargetOptionView,
  WorkspaceView,
} from './model.ts';
import { useRoute } from './router.ts';
import { subscribeAttempt, subscribeRuntime } from './stream-client.ts';
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
import {
  type RepositoryAuthorizationView,
  RepositoryList,
} from './views/repos/list.tsx';
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
    const draftId = path.replace(/^\/apps\/new\/?/, '') || null;
    return <NewAppScreen draftId={draftId} onNavigate={onNavigate} />;
  }
  if (path.startsWith('/targets')) return <TargetsScreen />;
  if (path.startsWith('/repos')) return <RepositoriesScreen />;
  if (path.startsWith('/deploys')) {
    const deployId = path.replace(/^\/deploys\/?/, '');
    return <DeployScreen deployId={deployId} onNavigate={onNavigate} />;
  }
  if (path === '/apps' || path === '')
    return <AppsScreen onNavigate={onNavigate} />;
  if (path.startsWith('/apps/')) {
    const appName = path.replace(/^\/apps\//, '');
    return <WorkspaceScreen appName={appName} onNavigate={onNavigate} />;
  }
  return <WorkspaceScreen appName={path.slice(1)} onNavigate={onNavigate} />;
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

function WorkspaceScreen({
  appName,
  onNavigate,
}: {
  appName: string;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'not-found'; message: string }
    | { type: 'error'; message: string }
    | { type: 'success'; workspace: WorkspaceView }
  >({ type: 'loading' });
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (!appName) {
      setState({ type: 'not-found', message: 'No App name provided' });
      return;
    }
    command('getAppWorkspace', { name: appName })
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ type: 'success', workspace: result.value.workspace });
        } else {
          if (result.failure.code === 'NOT_FOUND') {
            setState({ type: 'not-found', message: result.failure.message });
          } else {
            setState({ type: 'error', message: result.failure.message });
          }
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
  }, [appName]);

  const runtime =
    state.type === 'success' && state.workspace.runtime.kind === 'stream'
      ? state.workspace.runtime
      : null;
  useEffect(() => {
    if (runtime === null) return;
    return subscribeRuntime(
      {
        componentId: runtime.componentId,
        targetId: runtime.targetId,
      },
      (page) => {
        setState((current) => {
          if (
            current.type !== 'success' ||
            current.workspace.runtime.kind !== 'stream'
          ) {
            return current;
          }
          if (page.kind === 'error') return current;
          if (page.kind === 'none') {
            return {
              type: 'success',
              workspace: {
                ...current.workspace,
                runtime: { kind: 'none', because: page.because },
              },
            };
          }
          if (page.entries.length === 0) return current;
          return {
            type: 'success',
            workspace: {
              ...current.workspace,
              runtime: {
                ...current.workspace.runtime,
                lines: [
                  ...current.workspace.runtime.lines,
                  ...page.entries.map((entry) => ({
                    text: `${entry.replica}  ${entry.line}`,
                  })),
                ],
              },
            },
          };
        });
      },
    );
  }, [runtime?.componentId, runtime?.targetId]);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading workspace...
        </p>
      </div>
    );
  }

  if (state.type === 'not-found') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <Eyebrow>App Not Found</Eyebrow>
          <h1 className="mt-2 text-xl font-semibold">
            No App named "{appName}"
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={() => onNavigate('/apps')}>
              Back to Apps
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load workspace</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  const handleDeploy = async () => {
    if (state.type !== 'success') return;
    setDeploying(true);
    setDeployError(null);
    try {
      const result = await command('deployApp', { name: appName });
      if (result.ok) {
        onNavigate(`/deploys/${result.value.deployId}`);
      } else {
        setDeployError(result.failure.message);
      }
    } catch (e: unknown) {
      setDeployError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  };

  return (
    <>
      {deployError ? (
        <div className="mx-auto mt-4 w-full max-w-[1040px] px-5">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Deploy failed</p>
              <p className="text-sm mt-0.5">{deployError}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDeployError(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      <Workspace
        view={state.workspace}
        onDeploy={handleDeploy}
        deploying={deploying}
        onNavigate={onNavigate}
      />
    </>
  );
}

function DeployScreen({
  deployId,
  onNavigate,
}: {
  deployId: string;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'not-found'; message: string }
    | { type: 'error'; message: string }
    | { type: 'success'; deploy: DeployView }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    let stopStream: (() => void) | null = null;
    if (!deployId) {
      setState({ type: 'not-found', message: 'No Deploy ID specified' });
      return;
    }
    const parsedId = Number.parseInt(deployId, 10);
    if (Number.isNaN(parsedId)) {
      setState({
        type: 'not-found',
        message: `Invalid Deploy ID '${deployId}'`,
      });
      return;
    }
    command('getDeployDetail', { id: parsedId })
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ type: 'success', deploy: result.value.deploy });
          stopStream = subscribeAttempt(
            {
              buildId: result.value.deploy.buildId,
              deployId: result.value.deploy.id,
            },
            () => {
              void command('getDeployDetail', { id: parsedId }).then(
                (fresh) => {
                  if (live && fresh.ok) {
                    setState({
                      type: 'success',
                      deploy: fresh.value.deploy,
                    });
                  }
                },
              );
            },
          );
        } else {
          if (result.failure.code === 'NOT_FOUND') {
            setState({ type: 'not-found', message: result.failure.message });
          } else {
            setState({ type: 'error', message: result.failure.message });
          }
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
      stopStream?.();
    };
  }, [deployId]);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading deploy details...
        </p>
      </div>
    );
  }

  if (state.type === 'not-found') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <Eyebrow>Deploy Not Found</Eyebrow>
          <h1 className="mt-2 text-xl font-semibold">
            Deploy #{deployId} not found
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
          <div className="mt-4 flex justify-center">
            <Button variant="outline" onClick={() => onNavigate('/apps')}>
              Back to Apps
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load deploy detail</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return <DeployDetail view={state.deploy} />;
}

function TargetsScreen() {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; targets: readonly TargetListItem[] }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    command('listTargets', {})
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ type: 'success', targets: result.value.targets });
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
          Loading targets...
        </p>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load targets</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return <TargetList targets={state.targets} />;
}

function RepositoriesScreen() {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        repos: readonly LinkedRepoView[];
        options: readonly RepositoryOptionView[];
        available: readonly RepositoryOptionView[];
        connector: RepositoryConnectorView;
      }
  >({ type: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [authorization, setAuthorization] = useState<
    | (RepositoryAuthorizationView & {
        readonly attemptId: string;
        readonly intervalSeconds: number;
      })
    | null
  >(null);
  const [connecting, setConnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [openedPullRequest, setOpenedPullRequest] = useState<{
    fullName: string;
    number: number;
  } | null>(null);

  const handleRefresh = () => {
    setRefreshing(true);
    setRefresh((value) => value + 1);
  };

  useEffect(() => {
    let live = true;
    command('listRepositories', {})
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({ type: 'success', ...result.value });
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
      })
      .finally(() => {
        if (live) setRefreshing(false);
      });
    return () => {
      live = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (authorization?.state !== 'waiting') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = (seconds: number) => {
      timer = setTimeout(async () => {
        const result = await command('pollRepositoryAuthorization', {
          attemptId: authorization.attemptId,
        }).catch((cause: unknown) => ({
          ok: false as const,
          failure: {
            code: 'MALFORMED_REQUEST' as const,
            message:
              cause instanceof Error ? cause.message : 'GitHub poll failed',
          },
        }));
        if (!live) return;
        if (!result.ok) {
          setAuthorization((current) =>
            current === null
              ? null
              : {
                  ...current,
                  state: 'error',
                  message: result.failure.message,
                },
          );
          return;
        }
        if (result.value.state === 'pending') {
          poll(result.value.retryAfterSeconds);
        } else if (result.value.state === 'authorized') {
          setAuthorization(null);
          setRefresh((value) => value + 1);
        } else {
          const terminalState =
            result.value.state === 'denied' ? 'denied' : 'expired';
          setAuthorization((current) =>
            current === null ? null : { ...current, state: terminalState },
          );
        }
      }, seconds * 1000);
    };
    poll(authorization.intervalSeconds);
    return () => {
      live = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [
    authorization?.attemptId,
    authorization?.intervalSeconds,
    authorization?.state,
  ]);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading repositories...
        </p>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load repositories</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  const authorize = async () => {
    setActionError(null);
    try {
      const result = await command('beginRepositoryAuthorization', {});
      if (!result.ok) {
        setActionError(result.failure.message);
        return;
      }
      setAuthorization({
        ...result.value,
        state: 'waiting',
      });
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'GitHub authorization failed',
      );
    }
  };

  const connect = async (input: InputOf<'connectRepository'>) => {
    setConnecting(true);
    setActionError(null);
    setOpenedPullRequest(null);
    try {
      const result = await command('connectRepository', input);
      if (!result.ok) {
        setActionError(result.failure.message);
        return;
      }
      if (result.value.pullRequest !== null) {
        setOpenedPullRequest({
          fullName: result.value.fullName,
          number: result.value.pullRequest,
        });
      }
      setRefresh((value) => value + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Repository connection failed',
      );
    } finally {
      setConnecting(false);
    }
  };

  return (
    <RepositoryList
      repos={state.repos}
      options={state.available}
      connector={state.connector}
      authorization={authorization}
      connecting={connecting}
      refreshing={refreshing}
      error={actionError}
      openedPullRequest={openedPullRequest}
      onAuthorize={authorize}
      onConnect={connect}
      onRefresh={handleRefresh}
    />
  );
}

function NewAppScreen({
  draftId,
  onNavigate,
}: {
  draftId: string | null;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        targetOptions: readonly TargetOptionView[];
        repoOptions: readonly RepositoryOptionView[];
        draft: import('../domain/creation-draft.ts').CreationDraftView;
      }
  >({ type: 'loading' });
  // React Strict Mode replays effects in development. Supplying the identity
  // makes both starts the same authenticated act instead of leaving an orphan.
  const [startId] = useState(() => crypto.randomUUID());

  useEffect(() => {
    let live = true;
    const draftRequest =
      draftId === null
        ? command('startCreationDraft', { id: startId })
        : command('getCreationDraft', { id: draftId });
    Promise.all([
      command('listTargets', {}),
      command('listRepositories', {}),
      draftRequest,
    ])
      .then(([targetRes, repoRes, draftRes]) => {
        if (!live) return;
        if (!targetRes.ok) {
          setState({ type: 'error', message: targetRes.failure.message });
        } else if (!repoRes.ok) {
          setState({ type: 'error', message: repoRes.failure.message });
        } else if (!draftRes.ok) {
          setState({ type: 'error', message: draftRes.failure.message });
        } else {
          setState({
            type: 'success',
            targetOptions: targetRes.value.options,
            repoOptions: repoRes.value.options,
            draft: draftRes.value,
          });
          if (draftId === null) {
            onNavigate(`/apps/new/${draftRes.value.id}`);
          }
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
  }, [draftId, onNavigate, startId]);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading creation options...
        </p>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load creation options</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <NewApp
      key={state.draft.id}
      initial={state.draft}
      targets={state.targetOptions}
      repos={state.repoOptions}
      onCreated={(app) => onNavigate(`/apps/${app.id}`)}
    />
  );
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
