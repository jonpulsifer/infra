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
import { DeleteAppDialog, useAppDeletion } from './components/delete-app.tsx';
import type {
  AppListItem,
  DeployListItem,
  DeployView,
  LinkedRepoView,
  PendingTargetConnection,
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
import {
  SourceStorage,
  type SourceStorageView,
} from './views/storage/list.tsx';
import { TargetList } from './views/targets/list.tsx';

const NAV = [
  { path: '/apps', label: 'Apps' },
  { path: '/targets', label: 'Targets' },
  { path: '/repos', label: 'Repos' },
  { path: '/storage', label: 'Storage' },
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
  if (path.startsWith('/storage')) return <StorageScreen />;
  if (path.startsWith('/deploys')) {
    const deployId = path.replace(/^\/deploys\/?/, '');
    return <DeployScreen deployId={deployId} onNavigate={onNavigate} />;
  }
  // §4: pressing Deploy with nothing deployable starts a Build and writes no
  // intent, so the act has a durable id but no release. This is where that
  // press lands until an intent exists.
  if (path.startsWith('/builds')) {
    const buildId = path.replace(/^\/builds\/?/, '');
    return <BuildScreen buildId={buildId} onNavigate={onNavigate} />;
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

  // The row goes when the App does. Re-reading the list instead would be a
  // second round trip to learn something this screen was just told.
  //
  // By id, because `apps` has no unique constraint on `name`: filtering on the
  // name drops every row sharing it, so deleting one of two same-named Apps
  // would hide the other until a reload — and reaching the other one is the
  // whole point of giving this list an identity.
  const deletion = useAppDeletion(({ id }) => {
    setState((current) =>
      current.type === 'success'
        ? {
            type: 'success',
            apps: current.apps.filter((app) => app.id !== id),
          }
        : current,
    );
  });

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

  return (
    <>
      <AppList apps={state.apps} onNavigate={onNavigate} deletion={deletion} />
      <DeleteAppDialog deletion={deletion} />
    </>
  );
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
  const [rollingBack, setRollingBack] = useState<number | null>(null);
  /** Bumped when an act changed state the workspace has already read. */
  const [reloadToken, setReloadToken] = useState(0);

  // There is no workspace left to stand on once the App is gone.
  const deletion = useAppDeletion(() => onNavigate('/apps'));

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
  }, [appName, reloadToken]);

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

  // `rebuild` is passed explicitly rather than defaulted from a bare click
  // handler: a click hands its event to the first parameter, and an event is
  // truthy, so `onClick={handleDeploy}` would silently rebuild every press.
  const handleDeploy = async (rebuild: boolean) => {
    if (state.type !== 'success') return;
    setDeploying(true);
    setDeployError(null);
    try {
      // By id where the workspace knows one: `apps` does not constrain `name`,
      // and the command refuses a name two Apps answer to rather than guessing.
      const result = await command('deployApp', {
        name: state.workspace.appId ?? appName,
        rebuild,
      });
      if (result.ok) {
        // Both arms navigate. §4 makes "a Build started" a different act from
        // "an intent was written", not a lesser one — it has a durable id and a
        // live event stream — so the press lands on the attempt it started
        // rather than leaving the operator on the screen they pressed from,
        // wondering whether anything happened.
        onNavigate(
          result.value.deployId === null
            ? `/builds/${result.value.buildId}`
            : `/deploys/${result.value.deployId}`,
        );
      } else {
        // The sentence the command refused with, unedited — a disconnected
        // Target, a signature that did not verify. Nothing is retried behind it.
        setDeployError(result.failure.message);
      }
    } catch (e: unknown) {
      setDeployError(e instanceof Error ? e.message : 'Deploy failed');
    } finally {
      setDeploying(false);
    }
  };

  const handleRollback = async (release: DeployListItem) => {
    setRollingBack(release.id);
    setDeployError(null);
    try {
      const result = await rollback({
        componentId: release.componentId,
        targetId: release.targetId,
        buildId: release.buildId,
      });
      if (result.ok) {
        onNavigate(`/deploys/${result.deployId}`);
      } else {
        setDeployError(result.message);
        setReloadToken((token) => token + 1);
      }
    } finally {
      setRollingBack(null);
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
        onDeploy={() => handleDeploy(false)}
        onRebuild={() => handleDeploy(true)}
        deploying={deploying}
        onNavigate={onNavigate}
        deletion={deletion}
        onRollback={handleRollback}
        rollingBack={rollingBack}
      />
      <DeleteAppDialog deletion={deletion} />
    </>
  );
}

/**
 * Make an older release live again (§6).
 *
 * Shared by the workspace and the attempt screen because a rollback is one act
 * with one refusal: §6 gives it no special path, and two call sites that
 * phrased its failures differently would be inventing the second admission
 * policy `rollbackDeploy` exists to avoid.
 */
async function rollback(
  target: InputOf<'rollbackDeploy'>,
): Promise<{ ok: true; deployId: number } | { ok: false; message: string }> {
  try {
    const result = await command('rollbackDeploy', target);
    return result.ok
      ? { ok: true, deployId: result.value.deployId }
      : { ok: false, message: result.failure.message };
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : 'Rollback failed',
    };
  }
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

  const [busy, setBusy] = useState<'redeploy' | 'rollback' | null>(null);
  const [redeployError, setRedeployError] = useState<string | null>(null);

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
              // Non-null on this screen by construction: `getDeployDetail`
              // answers about a Deploy, so its view always carries that id.
              deployId: result.value.deploy.id ?? parsedId,
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

  const handleRedeploy = async () => {
    if (state.type !== 'success') return;
    setBusy('redeploy');
    setRedeployError(null);
    try {
      // The App's id, not its name: `apps` has no unique constraint on `name`,
      // so redeploying by name would act on whichever row shares it.
      const result = await command('deployApp', { name: state.deploy.appId });
      if (result.ok) {
        onNavigate(
          result.value.deployId === null
            ? `/builds/${result.value.buildId}`
            : `/deploys/${result.value.deployId}`,
        );
      } else {
        // Surfaced verbatim and acted on no further: a refused redeploy is a
        // fact about this artifact and this Target, not a cue to build another.
        setRedeployError(result.failure.message);
      }
    } catch (e: unknown) {
      setRedeployError(e instanceof Error ? e.message : 'Redeploy failed');
    } finally {
      setBusy(null);
    }
  };

  const handleRollback = async () => {
    if (state.type !== 'success') return;
    const view = state.deploy;
    setBusy('rollback');
    setRedeployError(null);
    try {
      const result = await rollback({
        componentId: view.componentId,
        targetId: view.targetId,
        buildId: view.buildId,
      });
      if (result.ok) {
        onNavigate(`/deploys/${result.deployId}`);
      } else {
        setRedeployError(result.message);
      }
    } finally {
      setBusy(null);
    }
  };

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

  return (
    <>
      {redeployError ? (
        <div className="mx-auto mt-4 w-full max-w-[1040px] px-5">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">That act was refused</p>
              <p className="text-sm mt-0.5">{redeployError}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRedeployError(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      <DeployDetail
        view={state.deploy}
        actions={{
          onRedeploy: handleRedeploy,
          onRollback: handleRollback,
          busy,
        }}
        onNavigate={onNavigate}
      />
    </>
  );
}

/**
 * The attempt screen for a Build that has no Deploy (§4).
 *
 * The Deploy button has two outcomes and this is the screen for the second one:
 * "nothing was deployable, so a Build started" is a real act with a durable id
 * and a live event stream. Leaving the operator on the workspace would make the
 * press look like it did nothing.
 *
 * The screen resolves itself. A Build that reaches an intent has a better page
 * than this one, so when `getBuildDetail` reports a Deploy naming this Build
 * the screen hands over to `/deploys/:id` rather than continuing to render the
 * half of the story it can see.
 */
function BuildScreen({
  buildId,
  onNavigate,
}: {
  buildId: string;
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'not-found'; message: string }
    | { type: 'error'; message: string }
    | { type: 'success'; attempt: DeployView }
  >({ type: 'loading' });
  const [busy, setBusy] = useState<'redeploy' | 'deploy' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let stopStream: (() => void) | null = null;
    const parsedId = Number.parseInt(buildId, 10);
    if (!buildId || Number.isNaN(parsedId)) {
      setState({ type: 'not-found', message: `Invalid Build ID '${buildId}'` });
      return;
    }

    const read = async () => {
      const result = await command('getBuildDetail', { id: parsedId });
      if (!live) return;
      if (!result.ok) {
        setState({
          type: result.failure.code === 'NOT_FOUND' ? 'not-found' : 'error',
          message: result.failure.message,
        });
        return;
      }
      if (result.value.deployId !== null) {
        onNavigate(`/deploys/${result.value.deployId}`);
        return;
      }
      setState({ type: 'success', attempt: result.value.attempt });
    };

    read()
      .then(() => {
        if (!live) return;
        // The same authenticated stream the deploy screen uses, subscribed with
        // no `deployId` because there is not one yet.
        stopStream = subscribeAttempt({ buildId: parsedId }, () => {
          void read();
        });
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setState({
          type: 'error',
          message: cause instanceof Error ? cause.message : 'Server failure',
        });
      });

    return () => {
      live = false;
      stopStream?.();
    };
  }, [buildId, onNavigate]);

  const act = async (kind: 'redeploy' | 'deploy') => {
    if (state.type !== 'success') return;
    setBusy(kind);
    setActionError(null);
    try {
      // One command for both, because §4 gives the workspace button one
      // meaning: deploy the newest artifact, or start the Build that would
      // produce one. Pressing "Deploy this build" on a finished Build takes the
      // first arm; pressing "Build again" on a failed one takes the second.
      const result = await command('deployApp', { name: state.attempt.appId });
      if (result.ok) {
        onNavigate(
          result.value.deployId === null
            ? `/builds/${result.value.buildId}`
            : `/deploys/${result.value.deployId}`,
        );
      } else {
        setActionError(result.failure.message);
      }
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'Deploy failed');
    } finally {
      setBusy(null);
    }
  };

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading build...
        </p>
      </div>
    );
  }

  if (state.type === 'not-found') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-border bg-card p-6 text-center">
          <Eyebrow>Build Not Found</Eyebrow>
          <h1 className="mt-2 text-xl font-semibold">
            Build #{buildId} not found
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
          <p className="text-sm font-medium">Failed to load build</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <>
      {actionError ? (
        <div className="mx-auto mt-4 w-full max-w-[1040px] px-5">
          <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">That act was refused</p>
              <p className="text-sm mt-0.5">{actionError}</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setActionError(null)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
      <DeployDetail
        view={state.attempt}
        actions={{
          onDeployBuild: () => void act('deploy'),
          onRedeploy: () => void act('redeploy'),
          busy,
        }}
        onNavigate={onNavigate}
      />
    </>
  );
}

function TargetsScreen() {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        targets: readonly TargetListItem[];
        pending: readonly PendingTargetConnection[];
      }
  >({ type: 'loading' });
  const [connecting, setConnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /** Bumped after a connect, because the checklist it produced is the answer. */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    command('listTargets', {})
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setState({
            type: 'success',
            targets: result.value.targets,
            pending: result.value.pending,
          });
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
  }, [reloadToken]);

  const connect = async (input: InputOf<'connectTarget'>) => {
    setConnecting(true);
    setActionError(null);
    try {
      const result = await command('connectTarget', input);
      if (!result.ok) {
        setActionError(result.failure.message);
        return;
      }
      // §13: connect always succeeds, and what it produced is a checklist. The
      // list is re-read rather than patched because that checklist is the whole
      // outcome of the act and it came from a pass of the inspection loop.
      setReloadToken((token) => token + 1);
    } catch (cause) {
      setActionError(
        cause instanceof Error ? cause.message : 'Connecting the Target failed',
      );
    } finally {
      setConnecting(false);
    }
  };

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

  return (
    <TargetList
      targets={state.targets}
      pending={state.pending}
      connecting={connecting}
      error={actionError}
      onConnect={connect}
    />
  );
}

function StorageScreen() {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; view: SourceStorageView }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    command('listSourceBuckets', {})
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', view: result.value }
            : { type: 'error', message: result.failure.message },
        );
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setState({
          type: 'error',
          message: cause instanceof Error ? cause.message : 'Server failure',
        });
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  if (state.type === 'loading') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <p className="text-sm text-muted-foreground animate-pulse">
          Loading source storage...
        </p>
      </div>
    );
  }

  if (state.type === 'error') {
    return (
      <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
          <p className="text-sm font-medium">Failed to load source storage</p>
          <p className="text-sm mt-1">{state.message}</p>
        </div>
      </div>
    );
  }

  return (
    <SourceStorage
      view={state.view}
      onChanged={() => setReloadToken((token) => token + 1)}
    />
  );
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
