/**
 * The shell, and the client's whole route table.
 *
 * The object-first operational surfaces and their route table. Everything else
 * here is chrome that exists to reach them.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import { readSession, signOut } from './auth-client.ts';
import { command, type InputOf } from './client.ts';
import { DeleteAppDialog, useAppDeletion } from './components/delete-app.tsx';
import { AppShell } from './components/shell.tsx';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  DeployView,
  LinkedRepoView,
  LogLine,
  PendingTargetConnection,
  RepositoryConnectorView,
  RepositoryOptionView,
  TargetListItem,
  TargetOptionView,
  WorkspaceView,
} from './model.ts';
import { isInFlight } from './model.ts';
import { useRoute } from './router.ts';
import { subscribeAttempt, subscribeRuntime } from './stream-client.ts';
import { type Theme, useTheme } from './theme.ts';
import { Button } from './ui/button.tsx';
import { Eyebrow } from './ui/card.tsx';
import { cn } from './ui/utils.ts';
import { DeployDetail } from './views/apps/deploy-detail.tsx';
import { AppList } from './views/apps/list.tsx';
import { NewApp } from './views/apps/new/index.tsx';
import {
  type RunJob,
  type SetReach,
  Workspace,
} from './views/apps/workspace.tsx';
import { Gate } from './views/auth/gate.tsx';
import { InstallationSettings } from './views/auth/installation.tsx';
import { Onboarding } from './views/auth/onboarding.tsx';
import { IdentitySettings } from './views/auth/settings.tsx';
import { BuildLedger } from './views/operations/builds.tsx';
import { DeployLedger } from './views/operations/deploys.tsx';
import { Overview } from './views/operations/overview.tsx';
import {
  type RepositoryAuthorizationView,
  RepositoryList,
} from './views/repos/list.tsx';
import {
  EmptySettingsSection,
  SettingsLayout,
  type SettingsSection,
} from './views/settings/layout.tsx';
import { Storage, type StorageView } from './views/storage/list.tsx';
import { TargetList } from './views/targets/list.tsx';

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

/**
 * Whether this installation has been configured, and the document to onboard
 * from if it has not.
 *
 * The same shape as {@link Gatekeeping} and for the same reason: which screen
 * renders is a fact about the installation rather than a choice anybody makes,
 * and `asking` is a third state because rendering the product for one frame and
 * then replacing it with onboarding is the flash of a broken app this exists to
 * remove.
 */
export type Configuration =
  | { readonly state: 'asking' }
  | { readonly state: 'unconfigured'; readonly manifest: unknown }
  | {
      readonly state: 'configured';
      /**
       * Dotted paths where the mounted declaration disagrees with this
       * installation, from the same read that decided this state — never
       * recomputed, so it is only as fresh as the sign-in that fetched it.
       *
       * Carried this far up rather than left to the Settings screen alone
       * (`views/auth/installation.tsx`) so a disagreement is visible on every
       * screen `AppShell` wraps, not only one an operator has to think to
       * open — an installation nobody opens Settings on otherwise never
       * learns a merge did not reach the row. `[]` for every path that
       * resolved this state without a real answer: a failed or timed-out
       * read, or the write onboarding just made, none of which has an
       * opinion sharper than "nothing to report".
       */
      readonly declarationDivergence: readonly string[];
    };

/**
 * How long the whole product waits on the read below before rendering anyway.
 *
 * Generous, because the answer decides which application an operator is looking
 * at and guessing early on a merely-slow installation would replace the product
 * with a wizard for no reason. It is a ceiling on a hang, not a latency budget.
 */
const ASK_TIMEOUT_MS = 10_000;

export function App() {
  const route = useRoute();
  const [gate, setGate] = useState<Gatekeeping>({ state: 'asking' });
  const [installation, setInstallation] = useState<Configuration>({
    state: 'asking',
  });

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

  /**
   * Ask, once there is somebody to ask on behalf of, whether this installation
   * has been configured.
   *
   * **After the session rather than beside it**, which costs a second round
   * trip before the first paint of the product. The alternative is firing an
   * unauthenticated command on every anonymous load to learn a fact only a
   * signed-in operator can act on, and a 401 on the sign-in screen every time
   * is the worse trade.
   *
   * **A read that fails means the product**, not onboarding. Onboarding is the
   * more disruptive answer — it replaces the whole application — so a transport
   * failure resolves to the state that takes nothing away, and Settings still
   * reaches everything this screen would have asked.
   *
   * **And a read that never answers means the same thing**, which needs the
   * deadline below because a rejection is not the failure mode this one has. A
   * request a proxy is holding open, or one issued into a pod mid-rollout, does
   * not reject — it hangs, and `SignedIn` renders nothing while the answer is
   * outstanding. Without a deadline that is a blank document with no chrome and
   * no way to sign out, for as long as the socket stays up. The whole product is
   * behind this one read, so the read is not allowed to be the thing that never
   * finishes.
   */
  useEffect(() => {
    if (gate.state !== 'signed-in') {
      // A sign-out has to un-answer this: the next operator to sign in is a
      // different session on a possibly different installation state, and
      // carrying the previous answer over would show them the product while
      // this effect was still asking.
      setInstallation({ state: 'asking' });
      return;
    }
    let live = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    Promise.race([
      command('getInstallationManifest', {}),
      new Promise<null>((resolve) => {
        deadline = setTimeout(() => resolve(null), ASK_TIMEOUT_MS);
      }),
    ])
      .then((result) => {
        if (!live) return;
        setInstallation(
          result?.ok && !result.value.configured
            ? { state: 'unconfigured', manifest: result.value.manifest }
            : {
                state: 'configured',
                declarationDivergence: result?.ok
                  ? result.value.declarationDivergence
                  : [],
              },
        );
      })
      .catch(() => {
        if (live) {
          setInstallation({ state: 'configured', declarationDivergence: [] });
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
      path={route.path}
      onNavigate={route.navigate}
      onConfigured={() =>
        // Onboarding's own write just seeded this installation, so there is
        // nothing yet for a declaration to disagree with — see `Configuration`.
        setInstallation({ state: 'configured', declarationDivergence: [] })
      }
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
 * What somebody who has signed in is shown.
 *
 * Two things, and which one is not a preference: an installation that has been
 * configured gets the product, and one that has not gets onboarding *instead
 * of* it. Not beside it and not after it — an unconfigured installation has no
 * Apps, no Builds and no Targets, so the product it would otherwise render is a
 * navigation to six empty screens with one form buried at the end of it, and
 * every act reachable from there refuses on whichever placeholder it read first.
 *
 * Exported for `test/web/onboarding.test.tsx`, for the same reason {@link Screen}
 * is exported for the mounted route-table test: the claim is about *this*
 * function's branches, and a test that rendered `Onboarding` directly would be
 * asserting that a component it constructed itself renders. The discovery panel
 * on the settings screen shipped in exactly that state — every test around it
 * passed, and deleting the one line that mounted it changed nothing.
 */
export function SignedIn({
  principal,
  installation,
  path,
  onNavigate,
  onConfigured,
  onSignOut,
}: {
  readonly principal: Principal;
  readonly installation: Configuration;
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
      themeControl={<ThemeToggle />}
      onSignOut={onSignOut}
      declarationDivergence={installation.declarationDivergence}
    >
      <Screen path={path} onNavigate={onNavigate} />
    </AppShell>
  );
}

/**
 * The route table.
 *
 * **A screen that names one object is keyed on that object's id.** Every screen
 * below that takes an id holds evidence about *that* object in `useState` —
 * a Deploy's checklist, log, diagnosis and phase; a Build's attempt; a
 * workspace's timeline — and React reuses a component instance whose type and
 * position are unchanged. Switching between two Deploys of the same App is
 * exactly that case: without a key the instance survives, so the previous
 * Deploy's evidence stays on screen under the new Deploy's id until the fetch
 * for it returns, and every `useState` seeded from the old view (the build
 * drawer's open-ness, the transcript's) carries over with it. A different App
 * does not look broken only because the id in the path happens to change more
 * of the tree — the bug is the same one, and the key is what refuses it.
 *
 * The key does the second half too: a remount unmounts the old instance, which
 * runs its effect cleanup, which drops that fetch's `live` flag and closes its
 * stream. An in-flight response for the object navigated away from then has no
 * state cell left to write into — a structural guarantee rather than a race the
 * `live` flag has to win.
 *
 * Exported for `test/web/deploy-detail-mounted.test.tsx`, which mounts this
 * table and changes the path: the claim above is about *this* function's keys,
 * and a test that rendered `DeployScreen` itself would be asserting its own key
 * prop.
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
  if (path.startsWith('/targets') || path.startsWith('/repos'))
    return (
      <SettingsScreen path="/settings/connections" onNavigate={onNavigate} />
    );
  if (path.startsWith('/storage'))
    return (
      <SettingsScreen path="/settings/artifacts" onNavigate={onNavigate} />
    );
  if (path.startsWith('/apps/new')) {
    const draftId = path.replace(/^\/apps\/new\/?/, '') || null;
    return (
      <NewAppScreen
        key={draftId ?? 'new'}
        draftId={draftId}
        onNavigate={onNavigate}
      />
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
  // §4: pressing Deploy with nothing deployable starts a Build and writes no
  // intent, so the act has a durable id but no release. This is where that
  // press lands until an intent exists.
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
  const appName = path.slice(1);
  return (
    <WorkspaceScreen key={appName} appName={appName} onNavigate={onNavigate} />
  );
}

function SettingsScreen({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (path: string) => void;
}) {
  const requested = path.replace(/^\/settings\/?/, '').split('/')[0] ?? '';
  const section: SettingsSection = [
    'connections',
    'identity',
    'installation',
    'artifacts',
    'notifications',
    'danger',
  ].includes(requested)
    ? (requested as SettingsSection)
    : 'connections';

  return (
    <SettingsLayout section={section} onNavigate={onNavigate}>
      {section === 'connections' ? (
        <ConnectionsSettings onNavigate={onNavigate} />
      ) : section === 'identity' ? (
        <IdentitySettings />
      ) : section === 'installation' ? (
        <InstallationSettings />
      ) : section === 'artifacts' ? (
        <StorageScreen embedded />
      ) : section === 'notifications' ? (
        <EmptySettingsSection
          eyebrow="Settings / notifications"
          title="Notifications"
        >
          No notification destinations are configured. Operational state stays
          visible in Overview until this installation gains a delivery command.
        </EmptySettingsSection>
      ) : (
        <EmptySettingsSection
          eyebrow="Settings / danger zone"
          title="Destructive controls"
        >
          Destructive acts remain beside the objects they affect, where their
          impact can be named precisely. There is no installation-wide delete.
        </EmptySettingsSection>
      )}
    </SettingsLayout>
  );
}

function ConnectionsSettings({
  onNavigate,
}: {
  readonly onNavigate: (path: string) => void;
}) {
  return (
    <section>
      <Eyebrow>Settings / connections</Eyebrow>
      <h2 className="mt-1 text-2xl font-semibold tracking-tight">
        Connected systems
      </h2>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">
        Authorize source access and connect deployment Targets. Each provider
        keeps its concrete state and actions in one ruled row.
      </p>
      <div className="mt-6 divide-y divide-border border-y border-border">
        <RepositoriesScreen embedded />
        <TargetsScreen embedded onNavigate={onNavigate} />
      </div>
    </section>
  );
}

function OverviewScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        apps: readonly AppListItem[];
        builds: readonly BuildListItem[];
        deploys: readonly DeployLedgerItem[];
        targets: readonly TargetListItem[];
      }
  >({ type: 'loading' });

  useEffect(() => {
    let live = true;
    const read = () =>
      Promise.all([
        command('listApps', {}),
        command('listBuilds', { limit: 12 }),
        command('listAllDeploys', { limit: 12 }),
        command('listTargets', {}),
      ]).then(([apps, builds, deploys, targets]) => {
        if (!live) return;
        if (!apps.ok) {
          setState({ type: 'error', message: apps.failure.message });
          return;
        }
        if (!builds.ok) {
          setState({ type: 'error', message: builds.failure.message });
          return;
        }
        if (!deploys.ok) {
          setState({ type: 'error', message: deploys.failure.message });
          return;
        }
        if (!targets.ok) {
          setState({ type: 'error', message: targets.failure.message });
          return;
        }
        setState({
          type: 'success',
          apps: apps.value.apps,
          builds: builds.value.builds,
          deploys: deploys.value.deploys,
          targets: targets.value.targets,
        });
      });
    const fail = (cause: unknown) => {
      if (!live) return;
      setState({
        type: 'error',
        message: cause instanceof Error ? cause.message : 'Server failure',
      });
    };
    void read().catch(fail);
    const refresh = setInterval(() => void read().catch(fail), 15_000);
    return () => {
      live = false;
      clearInterval(refresh);
    };
  }, []);

  if (state.type === 'loading') {
    return <ScreenLoading>Loading Overview…</ScreenLoading>;
  }
  if (state.type === 'error') {
    return (
      <ScreenFailure title="Failed to load Overview">
        {state.message}
      </ScreenFailure>
    );
  }
  return <Overview {...state} onNavigate={onNavigate} />;
}

function BuildsScreen({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        builds: readonly BuildListItem[];
        nextBefore: number | null;
      }
  >({ type: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const readNewest = () =>
      command('listBuilds', {}).then((result) => {
        if (!live) return;
        if (!result.ok) {
          setState({ type: 'error', message: result.failure.message });
          return;
        }
        setState((current) =>
          current.type === 'success'
            ? {
                type: 'success',
                builds: mergeLedger(result.value.builds, current.builds),
                nextBefore: current.nextBefore,
              }
            : {
                type: 'success',
                builds: result.value.builds,
                nextBefore: result.value.nextBefore,
              },
        );
      });
    const fail = (cause: unknown) => {
      if (live) {
        setState({
          type: 'error',
          message: cause instanceof Error ? cause.message : 'Server failure',
        });
      }
    };
    void readNewest().catch(fail);
    const refresh = setInterval(() => void readNewest().catch(fail), 15_000);
    return () => {
      live = false;
      clearInterval(refresh);
    };
  }, []);

  const loadOlder = async () => {
    if (state.type !== 'success' || state.nextBefore === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const result = await command('listBuilds', {
        before: state.nextBefore,
      });
      if (!result.ok) {
        setOlderError(result.failure.message);
        return;
      }
      setState((current) =>
        current.type === 'success'
          ? {
              type: 'success',
              builds: mergeLedger(current.builds, result.value.builds),
              nextBefore: result.value.nextBefore,
            }
          : current,
      );
    } catch (cause) {
      setOlderError(
        cause instanceof Error ? cause.message : 'Loading older Builds failed',
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (state.type === 'loading') {
    return <ScreenLoading>Loading Builds…</ScreenLoading>;
  }
  if (state.type === 'error') {
    return (
      <ScreenFailure title="Failed to load Builds">
        {state.message}
      </ScreenFailure>
    );
  }
  return (
    <BuildLedger
      builds={state.builds}
      onNavigate={onNavigate}
      hasMore={state.nextBefore !== null}
      loadingMore={loadingOlder}
      loadError={olderError}
      onLoadMore={() => void loadOlder()}
    />
  );
}

function DeploysScreen({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        deploys: readonly DeployLedgerItem[];
        nextBefore: number | null;
      }
  >({ type: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const readNewest = () =>
      command('listAllDeploys', {}).then((result) => {
        if (!live) return;
        if (!result.ok) {
          setState({ type: 'error', message: result.failure.message });
          return;
        }
        setState((current) =>
          current.type === 'success'
            ? {
                type: 'success',
                deploys: mergeLedger(result.value.deploys, current.deploys),
                nextBefore: current.nextBefore,
              }
            : {
                type: 'success',
                deploys: result.value.deploys,
                nextBefore: result.value.nextBefore,
              },
        );
      });
    const fail = (cause: unknown) => {
      if (live) {
        setState({
          type: 'error',
          message: cause instanceof Error ? cause.message : 'Server failure',
        });
      }
    };
    void readNewest().catch(fail);
    const refresh = setInterval(() => void readNewest().catch(fail), 15_000);
    return () => {
      live = false;
      clearInterval(refresh);
    };
  }, []);

  const loadOlder = async () => {
    if (state.type !== 'success' || state.nextBefore === null) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const result = await command('listAllDeploys', {
        before: state.nextBefore,
      });
      if (!result.ok) {
        setOlderError(result.failure.message);
        return;
      }
      setState((current) =>
        current.type === 'success'
          ? {
              type: 'success',
              deploys: mergeLedger(current.deploys, result.value.deploys),
              nextBefore: result.value.nextBefore,
            }
          : current,
      );
    } catch (cause) {
      setOlderError(
        cause instanceof Error ? cause.message : 'Loading older Deploys failed',
      );
    } finally {
      setLoadingOlder(false);
    }
  };

  if (state.type === 'loading') {
    return <ScreenLoading>Loading Deploys…</ScreenLoading>;
  }
  if (state.type === 'error') {
    return (
      <ScreenFailure title="Failed to load Deploys">
        {state.message}
      </ScreenFailure>
    );
  }
  return (
    <DeployLedger
      deploys={state.deploys}
      onNavigate={onNavigate}
      hasMore={state.nextBefore !== null}
      loadingMore={loadingOlder}
      loadError={olderError}
      onLoadMore={() => void loadOlder()}
    />
  );
}

function mergeLedger<T extends { readonly id: number }>(
  first: readonly T[],
  second: readonly T[],
): readonly T[] {
  const byId = new Map(second.map((item) => [item.id, item]));
  for (const item of first) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => right.id - left.id);
}

function ScreenLoading({ children }: { children: string }) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-6 py-8">
      <p className="animate-pulse text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function ScreenFailure({
  title,
  children,
}: {
  title: string;
  children: string;
}) {
  return (
    <div className="mx-auto w-full max-w-[1320px] px-6 py-8">
      <div className="rounded-sm border border-destructive/50 bg-destructive/10 p-4 text-destructive">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm">{children}</p>
      </div>
    </div>
  );
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
  /** Bumped when an act changed state the workspace has already read. */
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * Which run's output is open, and the lines read so far (§17).
   *
   * Held here rather than in the card because the socket is: a job's tail is
   * one run's, so switching runs is a different subscription and the lines
   * start again — which is why they are cleared when the name changes rather
   * than appended to whatever the last run said.
   */
  const [following, setFollowing] = useState<string | null>(null);
  const [runLines, setRunLines] = useState<readonly LogLine[]>([]);

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

  /**
   * Keep the workspace current while something is moving.
   *
   * The attempt screen has the event stream; this screen has no such edge — it
   * read once at mount and then sat on whatever the phase was at that instant,
   * so a deploy started from here converged entirely off-screen. §18 puts the
   * running App first, and an App-first screen that cannot notice its App
   * coming up is the one that most needs to.
   *
   * Two cadences for the same reason the reconciler has two: while a release is
   * in flight the reader is watching, and once it settles the read is only
   * catching acts from elsewhere.
   */
  const inFlight =
    state.type === 'success' && isInFlight(state.workspace.phase);
  useEffect(() => {
    if (!appName) return;
    const timer = setInterval(
      () => {
        void command('getAppWorkspace', { name: appName })
          .then((result) => {
            if (!result.ok) return;
            const fresh = result.value.workspace;
            setState((current) => {
              // The runtime tail is accumulated by a socket, not by this read —
              // a fresh workspace carries only the server's first page of it,
              // so taking it wholesale would wipe the log every few seconds.
              if (
                current.type === 'success' &&
                current.workspace.runtime.kind === 'stream' &&
                fresh.runtime.kind === 'stream'
              ) {
                return {
                  type: 'success',
                  workspace: {
                    ...fresh,
                    runtime: {
                      ...fresh.runtime,
                      lines: current.workspace.runtime.lines,
                    },
                  },
                };
              }
              return { type: 'success', workspace: fresh };
            });
          })
          // A failed refresh is not a reason to replace a workspace that is on
          // screen and readable with an error page. The next tick tries again.
          .catch(() => {});
      },
      inFlight ? 2_000 : 20_000,
    );
    return () => clearInterval(timer);
  }, [appName, inFlight]);

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

  // A job's runs are read the same way a service's output is — one socket, one
  // cursor — with the run named. §17's two surfaces stay distinct in what they
  // are subscribed to, not in how they are transported.
  const runs =
    state.type === 'success' && state.workspace.runtime.kind === 'executions'
      ? state.workspace.runtime
      : null;
  useEffect(() => {
    setRunLines([]);
    if (runs === null || following === null) return;
    if (runs.componentId === undefined || runs.targetId === undefined) return;
    return subscribeRuntime(
      {
        componentId: runs.componentId,
        targetId: runs.targetId,
        execution: following,
      },
      (page) => {
        // The two non-stream frames are exactly the cases criterion 4 fails in
        // — `pods/log` not granted, the pods garbage collected, Cloud Logging
        // refusing — and dropping them made those look identical to a run that
        // printed nothing. They are the only thing this pane has to say, so
        // they replace it rather than being appended to it.
        if (page.kind === 'none') {
          setRunLines([{ text: page.because }]);
          return;
        }
        if (page.kind === 'error') {
          setRunLines([{ text: page.message }]);
          return;
        }
        if (page.entries.length === 0) return;
        setRunLines((lines) => [
          ...lines,
          ...page.entries.map((entry) => ({
            text: `${entry.replica}  ${entry.line}`,
          })),
        ]);
      },
    );
  }, [runs?.componentId, runs?.targetId, following]);

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

  // §9: the row is written and the release is not, so the workspace is re-read
  // rather than patched in place — `Deploy` next to a Component whose reach
  // just changed has to be reading the same row the next intent will pin.
  const handleSetReach: SetReach = async (change) => {
    try {
      const result = await command('setComponentReach', change);
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true, pendingRelease: result.value.pendingRelease };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Saving reach failed',
      };
    }
  };

  /**
   * Start one run (§17), then re-read: the list on the screen was written
   * before the run existed, and a run that does not appear reads as a press
   * that did nothing.
   */
  const handleRunJob: RunJob = async () => {
    const job =
      state.type === 'success' && state.workspace.runtime.kind === 'executions'
        ? state.workspace.runtime
        : null;
    if (job?.componentId === undefined || job.targetId === undefined) {
      return { ok: false, message: 'This job has not been placed on a Target' };
    }
    try {
      const result = await command('runComponent', {
        componentId: job.componentId,
        targetId: job.targetId,
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Starting the run failed',
      };
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
        onSetReach={handleSetReach}
        {...(runs === null
          ? {}
          : {
              onRunJob: handleRunJob,
              onFollowExecution: setFollowing,
              executionLines: runLines,
            })}
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
 * One Build as an artifact-production attempt (§4).
 *
 * It stays a Build after placement: a related Deploy answers a different
 * question, so this screen links across without replacing artifact evidence.
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
    | { type: 'success'; attempt: DeployView; deployId: number | null }
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
      setState({
        type: 'success',
        attempt: result.value.attempt,
        deployId: result.value.deployId,
      });
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
  }, [buildId]);

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
      {state.deployId !== null ? (
        <div className="mx-auto mt-4 flex w-full max-w-[1040px] items-center justify-between gap-4 px-5">
          <p className="text-sm text-muted-foreground">
            This artifact is related to Deploy #{state.deployId}.
          </p>
          <Button
            variant="outline"
            onClick={() => onNavigate(`/deploys/${state.deployId}`)}
          >
            Open related Deploy
          </Button>
        </div>
      ) : null}
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

function TargetsScreen({
  embedded = false,
  onNavigate,
}: {
  embedded?: boolean;
  onNavigate?: (path: string) => void;
}) {
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
      onChanged={() => setReloadToken((token) => token + 1)}
      onNavigate={onNavigate}
      embedded={embedded}
    />
  );
}

function StorageScreen({ embedded = false }: { embedded?: boolean }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; view: StorageView }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    // Three reads, one screen, one failure state. Two of them answer from the
    // manifest and the third from the database, so a slow one is the slow one
    // for everybody — which is the honest cost of the sections being one page.
    Promise.all([
      command('listSourceBuckets', {}),
      command('listArtifactRegistries', {}),
      command('listStagedBundles', {}),
    ])
      .then(([buckets, registries, bundles]) => {
        if (!live) return;
        const refused = [buckets, registries, bundles].find(
          (result) => !result.ok,
        );
        if (refused !== undefined && !refused.ok) {
          setState({ type: 'error', message: refused.failure.message });
          return;
        }
        if (!buckets.ok || !registries.ok || !bundles.ok) return;
        setState({
          type: 'success',
          view: {
            source: buckets.value,
            registries: registries.value.registries,
            canHoldCredentials: registries.value.canHoldCredentials,
            bundles: bundles.value.bundles,
            bundleLimit: bundles.value.limit,
          },
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
    <Storage
      view={state.view}
      onChanged={() => setReloadToken((token) => token + 1)}
      embedded={embedded}
    />
  );
}

function RepositoriesScreen({ embedded = false }: { embedded?: boolean }) {
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
      embedded={embedded}
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
    // The Targets read follows the draft rather than racing it: placement is
    // derived from what is being created (§3), so asking before the draft
    // exists is asking about a different workload. Repositories still load
    // alongside it — that read depends on nothing.
    (async () => {
      const draftRes = await draftRequest;
      if (!live) return;
      if (!draftRes.ok) {
        setState({ type: 'error', message: draftRes.failure.message });
        return;
      }
      const { kind, reach, auth } = draftRes.value.draft;
      const [targetRes, repoRes] = await Promise.all([
        command('listTargets', { kind, reach, auth }),
        command('listRepositories', {}),
      ]);
      if (!live) return;
      if (!targetRes.ok) {
        setState({ type: 'error', message: targetRes.failure.message });
        return;
      }
      if (!repoRes.ok) {
        setState({ type: 'error', message: repoRes.failure.message });
        return;
      }
      setState({
        type: 'success',
        targetOptions: targetRes.value.options,
        repoOptions: repoRes.value.options,
        draft: draftRes.value,
      });
      if (draftId === null) {
        onNavigate(`/apps/new/${draftRes.value.id}`);
      }
    })().catch((e: unknown) => {
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
