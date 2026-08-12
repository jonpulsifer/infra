/**
 * The shell, and the client's whole route table.
 *
 * The object-first operational surfaces and their route table. Everything else
 * here is chrome that exists to reach them.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import type { ComponentKind } from '../domain/desired-state.ts';
import { readSession, signOut } from './auth-client.ts';
import {
  command,
  type InputOf,
  type OutputOf,
  type TransportFailure,
} from './client.ts';
import { DeleteAppDialog, useAppDeletion } from './components/delete-app.tsx';
import { AppShell } from './components/shell.tsx';
import type {
  AppListItem,
  BuildListItem,
  DeployLedgerItem,
  DeployView,
  GrantedRepositoryView,
  LinkedRepoView,
  LogLine,
  PendingTargetConnection,
  RepositoryConnectorView,
  RepositoryOptionView,
  TargetListItem,
  TargetOptionView,
  VesselListItem,
  WorkspaceView,
} from './model.ts';
import { isInFlight } from './model.ts';
import { useRoute } from './router.ts';
import { SESSION_EXPIRED_EVENT } from './session-events.ts';
import { subscribeAttempt, subscribeRuntime } from './stream-client.ts';
import { type Theme, useTheme } from './theme.ts';
import { Button } from './ui/button.tsx';
import { Eyebrow } from './ui/card.tsx';
import { ErrorState } from './ui/error-state.tsx';
import { Page } from './ui/page.tsx';
import { Skeleton, SkeletonRows } from './ui/skeleton.tsx';
import { notify } from './ui/toast.tsx';
import { cn } from './ui/utils.ts';
import { DeployDetail } from './views/apps/deploy-detail.tsx';
import { AppList } from './views/apps/list.tsx';
import {
  type CreationLoad,
  CreationLoadFailure,
  CreationSkeleton,
  NewApp,
} from './views/apps/new/index.tsx';
import {
  type CreateComponent,
  type CreateDatastore,
  type DatastoreAct,
  type MoveComponent,
  type RunJob,
  type SetAutoDeploy,
  type SetConfig,
  type SetReach,
  type UnplaceComponent,
  Workspace,
} from './views/apps/workspace.tsx';
import { Gate } from './views/auth/gate.tsx';
import { InstallationSettings } from './views/auth/installation.tsx';
import { Onboarding } from './views/auth/onboarding.tsx';
import { IdentitySettings } from './views/auth/settings.tsx';
import {
  DatastoreLedger,
  type DatastoreAct as DatastoreLedgerAct,
} from './views/operations/datastores.tsx';
import { DeployLedger } from './views/operations/deploys.tsx';
import { Overview } from './views/operations/overview.tsx';
import {
  type RepositoryAuthorizationView,
  RepositoryList,
} from './views/repos/list.tsx';
import {
  ArtifactRegistries,
  SourceBuckets,
} from './views/settings/connections.tsx';
import {
  EmptySettingsSection,
  SettingsLayout,
  type SettingsSection,
} from './views/settings/layout.tsx';
import { ArtifactLedger } from './views/supply-chain/artifacts.tsx';
import { BuildLedger } from './views/supply-chain/builds.tsx';
import { SourceLedger } from './views/supply-chain/sources.tsx';
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
   * Re-gate on the one signal `client.ts`, the archive upload, and
   * `stream-client.ts` all raise the same way: a 24h session that expired
   * mid-visit, read as `UNAUTHENTICATED` by a transport with nothing sensible
   * to render for it. The reset is the same shape `onSignOut` below already
   * uses — this installation is still claimed, and nothing here suggests the
   * linked Gateway went anywhere.
   */
  useEffect(() => {
    const onExpired = () =>
      setGate({ state: 'anonymous', claimed: true, gatewayUnlinked: false });
    addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
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
  // Every system Spindrift holds an address for is one screen, so the three
  // routes that used to be their own land on it. `/storage` is among them: the
  // buckets and registries it named are connections, and the bundles it listed
  // are Sources.
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
  // Must land before the catch-all below, which otherwise reads any
  // unmatched single segment as an App name — `/datastores` would render a
  // `WorkspaceScreen` for an App called "datastores" that does not exist.
  if (path.startsWith('/datastores'))
    return <DatastoresScreen onNavigate={onNavigate} />;
  // The one screen keyed on the route rather than on the object in it, because
  // it is the one screen that *names* its object partway through: a draft
  // starts, the path is rewritten to `/apps/new/<id>`, and a key reading that
  // id would tear down the screen that just created it. `NewAppScreen` keeps
  // its own record of which draft is loaded and keys `NewApp` on it, so a
  // different draft still resets everything a different draft should.
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
        Every system outside Spindrift that Spindrift holds an address for. Each
        provider keeps its concrete state and actions in one ruled row, and the
        order is the supply chain: where code comes from, where a Source is
        staged, where an Artifact is pushed, and where it runs.
      </p>
      <div className="mt-6 divide-y divide-border border-y border-border">
        <RepositoriesScreen embedded />
        <SourceBuckets />
        <ArtifactRegistries />
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
        /**
         * Whether the two paged reads had more to give.
         *
         * Both were asked for twelve and both answer with the cursor for the
         * thirteenth, which this screen used to drop on the floor — and then
         * counted the twelve it kept as if they were the fleet. Keeping the
         * cursor is the whole fix: nothing here pages, it only needs to know
         * that "3 running" is three of the newest twelve and not three in the
         * installation.
         */
        buildsHasMore: boolean;
        deploysHasMore: boolean;
      }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

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
          buildsHasMore: builds.value.nextBefore !== null,
          deploysHasMore: deploys.value.nextBefore !== null,
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
  }, [reloadToken]);

  if (state.type === 'loading') return <OverviewSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Overview"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }
  // Spread whole, which is how `buildsHasMore`/`deploysHasMore` reach
  // `Overview` without this file having to know whether it reads them yet: a
  // JSX spread carries what the receiver declares and drops the rest.
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
  const [reloadToken, setReloadToken] = useState(0);

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
  }, [reloadToken]);

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

  if (state.type === 'loading') return <LedgerSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Builds"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
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
  const [reloadToken, setReloadToken] = useState(0);

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
  }, [reloadToken]);

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

  if (state.type === 'loading') return <LedgerSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Deploys"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
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

/**
 * The three states every screen in this file is in before it has its data, and
 * the one container all three of them share.
 *
 * They share a container because they did not, and that was the visible bug:
 * six screens rendered `Loading Overview…` inside `max-w-[1040px]` and then
 * mounted their content inside `max-w-[1320px]`, so arriving anywhere shifted
 * the whole page sideways the instant the read returned. `Page` names the two
 * widths, and a loading state that passes the same one its screen passes cannot
 * disagree with it.
 *
 * `LedgerSkeleton` is a header and rows, `DetailSkeleton` is a hero and cards —
 * the two shapes this file actually loads. Neither tries to be a picture of the
 * real screen; a skeleton is a promise about *where* things land, and one that
 * chases the layout is one more thing to keep in sync.
 */
function LedgerSkeleton({
  width = 'wide',
  rows = 6,
}: {
  width?: 'wide' | 'reading';
  rows?: number;
}) {
  return (
    <Page width={width}>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-64" />
      </div>
      <SkeletonRows rows={rows} />
    </Page>
  );
}

/**
 * The landing screen, which is tiles over a feed and not a ledger.
 *
 * Its own shape rather than `LedgerSkeleton` with more rows, because the tile
 * strip is the tallest thing above the fold: standing in for it with rows moves
 * the feed up by a hundred pixels and then drops it back down, which is the
 * jump a skeleton exists to prevent.
 */
function OverviewSkeleton() {
  return (
    <Page>
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-56" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
        <Skeleton className="h-24" />
      </div>
      <SkeletonRows rows={8} />
    </Page>
  );
}

function DetailSkeleton() {
  return (
    <Page width="reading">
      <div className="flex flex-col gap-2.5">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8 w-72" />
      </div>
      <Skeleton className="h-28" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-44" />
        <Skeleton className="h-44" />
      </div>
    </Page>
  );
}

/**
 * One ruled row of the Connections screen, loading.
 *
 * No `Page` around it, unlike every other skeleton here: the Targets and
 * Repositories screens only ever render inside `ConnectionsSettings`'
 * `divide-y` stack, so a centred max-width column would indent them out of
 * alignment with the two sections that resolved first — which is precisely the
 * jump this screen was worst at, three grey lines settling at three different
 * moments and shifting the ones below each time.
 */
function SectionSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-4 py-6">
      <Skeleton className="h-4 w-40" />
      <SkeletonRows rows={rows} />
    </div>
  );
}

/**
 * A load that failed, with the button that re-runs it.
 *
 * Every caller passes `onRetry`, and every one of them had to grow a token to
 * do it. That is the change: a screen whose read failed has nothing on it, so
 * the reader's only previous way forward was reloading a hash-routed
 * application to re-run one query.
 */
function ScreenFailure({
  title,
  message,
  onRetry,
  width = 'wide',
}: {
  title: string;
  message: string;
  onRetry: () => void;
  width?: 'wide' | 'reading';
}) {
  return (
    <Page width={width}>
      <ErrorState title={title} message={message} onRetry={onRetry} />
    </Page>
  );
}

/**
 * An id in the path that names nothing.
 *
 * Three screens rendered this as a centred card with an eyebrow, a heading, the
 * server's sentence and a `Back to Apps` button — the same card three times,
 * differing in two words. It is the same failure `ScreenFailure` renders, plus
 * the one thing a not-found has that a transport failure does not: somewhere
 * definite to go.
 */
function ScreenNotFound({
  title,
  message,
  onNavigate,
}: {
  title: string;
  message: string;
  onNavigate: (path: string) => void;
}) {
  return (
    <Page width="reading">
      <ErrorState
        title={title}
        code="NOT_FOUND"
        message={message}
        secondary={
          <Button
            size="sm"
            variant="outline"
            onClick={() => onNavigate('/apps')}
          >
            Back to Apps
          </Button>
        }
      />
    </Page>
  );
}

function AppsScreen({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; apps: readonly AppListItem[] }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  // The row goes when the App does. Re-reading the list instead would be a
  // second round trip to learn something this screen was just told.
  //
  // By id, because `apps` has no unique constraint on `name`: filtering on the
  // name drops every row sharing it, so deleting one of two same-named Apps
  // would hide the other until a reload — and reaching the other one is the
  // whole point of giving this list an identity.
  const deletion = useAppDeletion(({ id, name }) => {
    setState((current) =>
      current.type === 'success'
        ? {
            type: 'success',
            apps: current.apps.filter((app) => app.id !== id),
          }
        : current,
    );
    // The dialog that confirmed this closes with the press, so without this the
    // only evidence the act happened is a row that is no longer there — which
    // is indistinguishable from having deleted the wrong one.
    notify({ tone: 'success', title: `Deleted ${name}` });
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
  }, [reloadToken]);

  /**
   * Keep the list current, at the two cadences the workspace already uses.
   *
   * This screen read once at mount and never again, so a row whose App was
   * mid-release sat on the phase it happened to have at that instant — under a
   * dot the explorer pulses forever, which reads as "still moving" about a
   * release that finished minutes ago. The workspace worked this out already;
   * this is the same argument for the screen an operator watches a fleet from.
   *
   * A failed refresh is dropped rather than replacing a readable list with an
   * error page. The next tick tries again.
   */
  const inFlight =
    state.type === 'success' && state.apps.some((app) => isInFlight(app.phase));
  useEffect(() => {
    let live = true;
    const timer = setInterval(
      () => {
        void command('listApps', {})
          .then((result) => {
            if (!live || !result.ok) return;
            setState({ type: 'success', apps: result.value.apps });
          })
          .catch(() => {});
      },
      inFlight ? 3_000 : 20_000,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [inFlight]);

  if (state.type === 'loading') return <LedgerSkeleton width="reading" />;

  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Apps"
        message={state.message}
        width="reading"
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }

  return (
    <>
      <AppList apps={state.apps} onNavigate={onNavigate} deletion={deletion} />
      <DeleteAppDialog deletion={deletion} />
    </>
  );
}

/**
 * A refreshed workspace, keeping the log lines the socket has accumulated.
 *
 * A read carries only the server's first page of a runtime tail — every line
 * after it arrived over a socket and lives in this screen's state — so taking
 * `runtime` wholesale would wipe the log on every refresh.
 *
 * The lines are kept only where both reads are about the same Component on the
 * same Target. The selection can move while a refresh is in flight, and a
 * Component's output rendered under another Component's name is a worse answer
 * than the empty card the next socket page fills.
 *
 * Exported for `test/web/workspace-refresh.test.ts`: this is where the
 * selection and the socket meet, and reaching it through the mounted screen
 * means pressing a row, which the DOM shim does not simulate.
 */
export function refreshedWorkspace(
  current: WorkspaceView,
  fresh: WorkspaceView,
): WorkspaceView {
  const accumulated = current.runtime;
  if (
    accumulated.kind !== 'stream' ||
    fresh.runtime.kind !== 'stream' ||
    accumulated.componentId !== fresh.runtime.componentId ||
    accumulated.targetId !== fresh.runtime.targetId
  ) {
    return fresh;
  }
  return {
    ...fresh,
    runtime: { ...fresh.runtime, lines: accumulated.lines },
  };
}

/**
 * The Target a press on Deploy has to name, or nothing where it must not.
 *
 * Placement is a fact `placeComponent` or a first deploy writes, so a Component
 * that has done neither has none to read back and `deployApp` refuses rather
 * than guessing (`src/commands/apps/deploy.ts:390-395`). That never mattered
 * while every Component was declared by the create flow, which places as it
 * creates — and it matters for every Component the Components card adds, because
 * `createComponent` deliberately writes no placement.
 *
 * `targetId` is the *selected* Component's placement of record
 * (`src/commands/apps/workspace.ts:129`), so its absence is the whole test, and
 * a sibling's row is where the answer comes from: an App's Components are placed
 * one Target apiece and a `job` added beside a `service` joins the Target that
 * service is on. What travels is the `<vessel>/<adapter>` spelling the row
 * already states, which `deployApp` resolves (`deploy.ts:352-362`).
 *
 * **Never for a Component that has a placement.** A Target named against one is
 * a move, and moves go through `placeComponent` — `deployApp` refuses the
 * disagreement (`deploy.ts:379-386`) rather than landing somewhere new, and this
 * side does not put it in the position of having to.
 *
 * Exported for `test/web/component-create.test.ts`, for the reason
 * {@link refreshedWorkspace} is: reaching it through the mounted screen means
 * pressing Deploy, which the DOM shim does not simulate.
 */
export function targetForFirstDeploy(view: WorkspaceView): string | undefined {
  if (view.targetId !== undefined) return undefined;
  return view.components.find((component) => component.target !== undefined)
    ?.target;
}

/**
 * What the Components card's form posts, composed per kind.
 *
 * `createComponentInput` is a `.strict()` discriminated union
 * (`src/commands/components/create.ts:68-98`), so this is a branch rather than
 * one object with optional fields: `schedule` reaching a service is a
 * validation failure, not a field the handler ignores.
 *
 * `reach`, `auth` and `expose` are the schema's own defaults, restated here
 * because `InputOf` reads a command's schema *output* — the same reason
 * `handleCreateDatastore` restates `storageGiB` below, and the same care: no
 * form offers any of the three, so this is the one place they are named, and
 * naming them here is what keeps the form from having a second opinion.
 *
 * Exported for `test/web/component-create.test.ts`, for the reason
 * {@link refreshedWorkspace} is: what is under test is which fields a kind
 * sends, and reaching it through the mounted screen means pressing a tile,
 * which the DOM shim does not simulate.
 */
export function componentCreation(
  appId: string,
  create: { name: string; kind: ComponentKind; schedule?: string },
): InputOf<'createComponent'> {
  const common = {
    appId,
    name: create.name,
    reach: 'private',
    auth: 'proxy',
  } as const;
  switch (create.kind) {
    case 'service':
      return { ...common, kind: 'service', expose: true };
    case 'website':
      return { ...common, kind: 'website' };
    case 'job':
      return {
        ...common,
        kind: 'job',
        // Absent rather than empty for an unscheduled job — §7 renders that as
        // a suspended CronJob, and `''` is not a five-field cron expression.
        ...(create.schedule === undefined ? {} : { schedule: create.schedule }),
      };
  }
}

/**
 * The keys a refused move demands, read off the refusal rather than out of it.
 *
 * `placeComponent` names them twice: in §10's sentence, which is written for a
 * person, and as `issues` at `supply.<KEY>`, which is written for this. Only
 * the second is safe to build a form from — the first is prose, and a form
 * assembled by splitting prose breaks the day somebody improves the wording.
 *
 * Every other refusal answers `[]`, which is what makes the empty case the
 * test: a move refused for a reason that is not a demand is a sentence to
 * read, not a form to fill.
 *
 * Exported for `test/web/component-move.test.ts`, for the reason
 * {@link refreshedWorkspace} is: reaching it through the mounted screen means
 * pressing Move, which the DOM shim does not simulate.
 */
export function demandedKeys(failure: TransportFailure): readonly string[] {
  return (failure.issues ?? [])
    .filter((issue) => issue.path.startsWith('supply.'))
    .map((issue) => issue.path.slice('supply.'.length));
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
  /** Bumped when an act changed state the workspace has already read. */
  const [reloadToken, setReloadToken] = useState(0);
  /**
   * Which Component the screen is showing, or `null` for the App's first.
   *
   * Held here rather than in the URL: picking a Component is inspection within
   * one screen, the same call the object explorers make. It is `null` rather
   * than the first Component's name because the server answers that question —
   * a client that named a default would be a second answer to it, wrong for
   * every App whose Components are not in the order this guessed.
   */
  const [component, setComponent] = useState<string | null>(null);
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
  /**
   * The Targets a move can name (§3).
   *
   * Read once beside the workspace rather than folded into it: `getAppWorkspace`
   * answers about one App, and the installation's Targets are not one App's
   * fact — the Targets screen reads the same list. Empty until it arrives, and
   * empty is also what a failed read leaves, which is the honest state: the
   * move control is not offered over a list this screen has not got, rather
   * than offered over an empty one.
   */
  const [targets, setTargets] = useState<readonly TargetListItem[]>([]);

  // There is no workspace left to stand on once the App is gone.
  const deletion = useAppDeletion(() => onNavigate('/apps'));

  useEffect(() => {
    let live = true;
    if (!appName) {
      setState({ type: 'not-found', message: 'No App name provided' });
      return;
    }
    command('getAppWorkspace', {
      name: appName,
      ...(component === null ? {} : { component }),
    })
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
  }, [appName, component, reloadToken]);

  // Once, on mount. Connecting a Target happens on another screen, and a move
  // does not change what Targets exist — so this list has nothing to re-read
  // it for, and putting it on the polling interval would be a second query per
  // tick answering the same way every time.
  useEffect(() => {
    let live = true;
    command('listTargets', {})
      .then((result) => {
        if (live && result.ok) setTargets(result.value.targets);
      })
      // Silently, and the consequence is stated where it lands: the Move
      // control is not offered without this list, which is a control that is
      // absent rather than one that opens on nothing.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

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
    // Dropped by the cleanup, the same way the read above drops its own: the
    // interval is re-armed whenever the selection moves, so a response still in
    // flight across that press is about a Component this screen has left, and
    // writing it would put that Component back on screen until the next tick.
    let live = true;
    const timer = setInterval(
      () => {
        // With the selection, or the refresh would put the App's first
        // Component back on screen every few seconds.
        void command('getAppWorkspace', {
          name: appName,
          ...(component === null ? {} : { component }),
        })
          .then((result) => {
            if (!live || !result.ok) return;
            const fresh = result.value.workspace;
            setState((current) => ({
              type: 'success',
              workspace:
                current.type === 'success'
                  ? refreshedWorkspace(current.workspace, fresh)
                  : fresh,
            }));
          })
          // A failed refresh is not a reason to replace a workspace that is on
          // screen and readable with an error page. The next tick tries again.
          .catch(() => {});
      },
      inFlight ? 2_000 : 20_000,
    );
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [appName, component, inFlight]);

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

  if (state.type === 'loading') return <DetailSkeleton />;

  if (state.type === 'not-found') {
    return (
      <ScreenNotFound
        title={`No App named "${appName}"`}
        message={state.message}
        onNavigate={onNavigate}
      />
    );
  }

  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load workspace"
        message={state.message}
        width="reading"
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }

  // `rebuild` is passed explicitly rather than defaulted from a bare click
  // handler: a click hands its event to the first parameter, and an event is
  // truthy, so `onClick={handleDeploy}` would silently rebuild every press.
  const handleDeploy = async (rebuild: boolean) => {
    if (state.type !== 'success') return;
    const firstPlacement = targetForFirstDeploy(state.workspace);
    setDeploying(true);
    try {
      // By id where the workspace knows one: `apps` does not constrain `name`,
      // and the command refuses a name two Apps answer to rather than guessing.
      const result = await command('deployApp', {
        name: state.workspace.appId ?? appName,
        rebuild,
        // A deploy is a press on one Component, and the header these buttons
        // sit in reads the selected Component's kind, phase and placement — so
        // it is that Component's release they start, not the App's first one's.
        ...(state.workspace.componentId === undefined
          ? {}
          : { component: state.workspace.componentId }),
        // The Target a Component deploying for the first time is placed on, and
        // nothing at all for one that is already placed. See
        // {@link targetForFirstDeploy}.
        ...(firstPlacement === undefined ? {} : { target: firstPlacement }),
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
        notify({
          tone: 'destructive',
          title: 'Deploy refused',
          detail: result.failure.message,
        });
      }
    } catch (e: unknown) {
      notify({
        tone: 'destructive',
        title: 'Deploy failed',
        detail: e instanceof Error ? e.message : 'Server failure',
      });
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

  // Deploy on push (§15). No re-read of the workspace: the toggle already
  // holds the answer it just wrote, and the reload `handleSetReach` needs is
  // because reach changes a *derived* row. This changes exactly the field the
  // control is showing.
  const handleSetAutoDeploy: SetAutoDeploy = async (autoDeploy) => {
    const appId = state.type === 'success' ? state.workspace.appId : undefined;
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to set the switch on' };
    }
    try {
      const result = await command('setAppAutoDeploy', { appId, autoDeploy });
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.failure.message };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error
            ? cause.message
            : 'Saving deploy-on-push failed',
      };
    }
  };

  // The pair this workspace is showing (§10) — bound here, once, so `SetConfig`
  // itself does not have to carry it on every call. Re-read on success for the
  // same reason `handleSetReach` is: `configKeys` is a row this act just
  // changed, and a key that was just deleted has to actually leave the list
  // rather than being patched out by a guess about what the write did.
  const handleSetConfig: SetConfig = async (change) => {
    const pair =
      state.type === 'success'
        ? {
            componentId: state.workspace.componentId,
            targetId: state.workspace.targetId,
          }
        : { componentId: undefined, targetId: undefined };
    if (pair.componentId === undefined || pair.targetId === undefined) {
      return {
        ok: false,
        message: 'This App has no Component placed on a Target yet',
      };
    }
    try {
      const result = await command('setConfig', {
        componentId: pair.componentId,
        targetId: pair.targetId,
        entries: [...change.entries],
        removals: [...change.removals],
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return {
        ok: true,
        written: result.value.written,
        removed: result.value.removed,
        notDeployed: result.value.notDeployed,
      };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Saving config failed',
      };
    }
  };

  /**
   * Show another Component of this App.
   *
   * The open run tail is dropped with the same press: an execution name belongs
   * to the Component that produced it, so carrying one across the selection
   * would subscribe to a run the newly selected Component has never had.
   */
  const handleSelectComponent = (name: string) => {
    setFollowing(null);
    setComponent(name);
  };

  /**
   * Add a Component to this App (§2), then re-read: the card that opened this
   * form is the list the new row belongs in, and a Component that does not
   * appear reads as a press that did nothing.
   *
   * Nothing else is written. `createComponent` leaves `placedTargetId` NULL and
   * the first Deploy fills it (`src/commands/apps/deploy.ts:529-534`), which is
   * why this handler does not follow up with a placement of its own — two acts
   * would be two answers to which Target this Component lives on.
   */
  const handleCreateComponent: CreateComponent = async (create) => {
    const { appId } = workspaceIds();
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to add a Component to' };
    }
    try {
      const result = await command(
        'createComponent',
        componentCreation(appId, create),
      );
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error
            ? cause.message
            : 'Creating the Component failed',
      };
    }
  };

  /**
   * Move a Component to another Target (§3, §10), then re-read: the placement
   * this screen states, the pairs still serving and the config keys are all
   * rows this act just changed.
   *
   * **One post, with whatever the form supplied on it.** The retry after a
   * demand is this same call again, not a `setConfig` pass followed by a second
   * attempt — `placeComponent` takes `supply` precisely so the move and the
   * values it demands commit together, and a two-step version would write those
   * values at a placement that does not exist yet.
   *
   * No deploy follows. The artifact travels on the next press of Deploy and on
   * nothing else: §3 makes a cross-shape move a rebuild, and deciding that here
   * would be the substitution `deployApp` refuses to make on the operator's
   * behalf.
   */
  const handleMoveComponent: MoveComponent = async (move) => {
    try {
      const result = await command('placeComponent', {
        componentId: move.componentId,
        targetId: move.targetId,
        supply: move.supply.map((entry) => ({
          key: entry.key,
          value: entry.value,
        })),
      });
      if (!result.ok) {
        return {
          ok: false,
          message: result.failure.message,
          demanded: demandedKeys(result.failure),
        };
      }
      setReloadToken((token) => token + 1);
      return { ok: true, carried: result.value.carried };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'The move failed',
        demanded: [],
      };
    }
  };

  /**
   * Retire one pair that still serves (§6, §13), then re-read.
   *
   * The teardown is the thing being asked for by name — `unplaceComponent`'s
   * own header argues why that is §13's exception rather than a violation of
   * it — so there is no confirmation here that the command does not have:
   * pressing Unplace on a named pair is the confirmation.
   */
  const handleUnplaceComponent: UnplaceComponent = async (pair) => {
    try {
      const result = await command('unplaceComponent', pair);
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true, destroyed: result.value.destroyed };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Retiring the pair failed',
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

  /*
    The four Datastore acts (§11). Every one of them is `handleSetConfig`'s
    shape: the pair the screen is showing is bound here so the card does not
    restate it, the command's own refusal is passed through unedited, and the
    workspace is re-read on success rather than patched — `phase` and
    `attachedTo` are rows this act just changed, and a guess about what the
    write did is the one thing that can disagree with the reconcile loop.
  */
  const workspaceIds = () =>
    state.type === 'success'
      ? { appId: state.workspace.appId, targetId: state.workspace.targetId }
      : { appId: undefined, targetId: undefined };

  /**
   * Create, then attach — two dispatches, because `createDatastore` takes no
   * App.
   *
   * That is the deliberate shape: `attachDatastore` is the single place the
   * attachment rules live (one store per engine per App, cluster-local
   * placement), and accepting an App on create would mean a second copy of them
   * that goes stale. So the failure of the second call is honest rather than
   * hidden — the Datastore exists, unattached, and the row is on screen saying
   * so, which is why the reload happens either way.
   */
  const handleCreateDatastore: CreateDatastore = async (create) => {
    const { appId, targetId } = workspaceIds();
    if (appId === undefined || targetId === undefined) {
      return {
        ok: false,
        message: 'This App has no Component placed on a Target yet',
      };
    }
    try {
      const created = await command('createDatastore', {
        name: create.name,
        engine: create.engine,
        targetId,
        // Restated rather than omitted, the way `useBucket`'s `makeDefault` is:
        // `InputOf` reads a command's schema *output*, so a `.default()` is
        // still a required property to a typed caller. It is the schema's own
        // number and there is no field for it — §11 gives a Datastore no size
        // control, and a form asking a developer for one on the day they
        // create it is asking a question they cannot answer.
        storageGiB: 10,
      });
      if (!created.ok) return { ok: false, message: created.failure.message };
      const attached = await command('attachDatastore', {
        datastoreId: created.value.id,
        appId,
      });
      setReloadToken((token) => token + 1);
      return attached.ok
        ? { ok: true }
        : { ok: false, message: attached.failure.message };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error
            ? cause.message
            : 'Creating the Datastore failed',
      };
    }
  };

  const handleAttachDatastore: DatastoreAct = async (datastoreId) => {
    const { appId } = workspaceIds();
    if (appId === undefined) {
      return {
        ok: false,
        message: 'This App has no id to attach a Datastore to',
      };
    }
    try {
      const result = await command('attachDatastore', { datastoreId, appId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Attaching failed',
      };
    }
  };

  const handleDetachDatastore: DatastoreAct = async (datastoreId) => {
    try {
      const result = await command('detachDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Detaching failed',
      };
    }
  };

  const handleDestroyDatastore: DatastoreAct = async (datastoreId) => {
    try {
      const result = await command('destroyDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Destroying failed',
      };
    }
  };

  return (
    <>
      <Workspace
        view={state.workspace}
        onDeploy={() => handleDeploy(false)}
        onRebuild={() => handleDeploy(true)}
        deploying={deploying}
        onNavigate={onNavigate}
        deletion={deletion}
        onSetReach={handleSetReach}
        onSetAutoDeploy={handleSetAutoDeploy}
        onSetConfig={handleSetConfig}
        onSelectComponent={handleSelectComponent}
        onCreateComponent={handleCreateComponent}
        onMoveComponent={handleMoveComponent}
        onUnplaceComponent={handleUnplaceComponent}
        targets={targets}
        onCreateDatastore={handleCreateDatastore}
        onAttachDatastore={handleAttachDatastore}
        onDetachDatastore={handleDetachDatastore}
        onDestroyDatastore={handleDestroyDatastore}
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
  const [reloadToken, setReloadToken] = useState(0);

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
  }, [deployId, reloadToken]);

  const handleRedeploy = async () => {
    if (state.type !== 'success') return;
    setBusy('redeploy');
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
        notify({
          tone: 'destructive',
          title: 'Redeploy refused',
          detail: result.failure.message,
        });
      }
    } catch (e: unknown) {
      notify({
        tone: 'destructive',
        title: 'Redeploy failed',
        detail: e instanceof Error ? e.message : 'Server failure',
      });
    } finally {
      setBusy(null);
    }
  };

  const handleRollback = async () => {
    if (state.type !== 'success') return;
    const view = state.deploy;
    setBusy('rollback');
    try {
      const result = await rollback({
        componentId: view.componentId,
        targetId: view.targetId,
        buildId: view.buildId,
      });
      if (result.ok) {
        // The scariest button in the product, and until now the only thing it
        // said on success was a different id in the URL. The build number is
        // what makes the sentence checkable against what the operator meant.
        notify({
          tone: 'success',
          title: `Rolled back to build ${view.buildId}`,
          detail: `Deploy #${result.deployId} is the release now serving.`,
        });
        onNavigate(`/deploys/${result.deployId}`);
      } else {
        notify({
          tone: 'destructive',
          title: 'Rollback refused',
          detail: result.message,
        });
      }
    } finally {
      setBusy(null);
    }
  };

  if (state.type === 'loading') return <DetailSkeleton />;

  if (state.type === 'not-found') {
    return (
      <ScreenNotFound
        title={`Deploy #${deployId} not found`}
        message={state.message}
        onNavigate={onNavigate}
      />
    );
  }

  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load deploy detail"
        message={state.message}
        width="reading"
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }

  return (
    <>
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
  const [reloadToken, setReloadToken] = useState(0);

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
  }, [buildId, reloadToken]);

  const act = async (kind: 'redeploy' | 'deploy') => {
    if (state.type !== 'success') return;
    setBusy(kind);
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
        notify({
          tone: 'destructive',
          title: 'That act was refused',
          detail: result.failure.message,
        });
      }
    } catch (cause) {
      notify({
        tone: 'destructive',
        title: 'Deploy failed',
        detail: cause instanceof Error ? cause.message : 'Server failure',
      });
    } finally {
      setBusy(null);
    }
  };

  if (state.type === 'loading') return <DetailSkeleton />;

  if (state.type === 'not-found') {
    return (
      <ScreenNotFound
        title={`Build #${buildId} not found`}
        message={state.message}
        onNavigate={onNavigate}
      />
    );
  }

  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load build"
        message={state.message}
        width="reading"
        onRetry={() => setReloadToken((token) => token + 1)}
      />
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
        vessels: readonly VesselListItem[];
      }
  >({ type: 'loading' });
  const [connecting, setConnecting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  /**
   * Surfaces the last connect established are not on the boundary it probed.
   *
   * Not an error — the connect succeeded — and not readable from the reloaded
   * list either, because what it says is about a Target that deliberately does
   * not exist. So it is the one part of the act's answer this screen keeps.
   */
  const [absent, setAbsent] = useState<readonly string[]>([]);
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
            vessels: result.value.vessels,
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
    setAbsent([]);
    try {
      const result = await command('connectTarget', input);
      if (!result.ok) {
        setActionError(result.failure.message);
        return;
      }
      setAbsent(
        result.value.absent.map(
          (surface) =>
            `${surface.vessel}/${surface.adapter} was not registered: ${surface.detail}`,
        ),
      );
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

  if (state.type === 'loading') return <SectionSkeleton rows={3} />;

  if (state.type === 'error') {
    return (
      <div className="py-6">
        <ErrorState
          title="Failed to load Targets"
          message={state.message}
          onRetry={() => setReloadToken((token) => token + 1)}
        />
      </div>
    );
  }

  return (
    <TargetList
      targets={state.targets}
      pending={state.pending}
      vessels={state.vessels}
      connecting={connecting}
      error={actionError}
      absent={absent}
      onConnect={connect}
      onChanged={() => setReloadToken((token) => token + 1)}
      onNavigate={onNavigate}
      embedded={embedded}
    />
  );
}

function SourcesScreen({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; result: OutputOf<'listSources'> }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    command('listSources', {})
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', result: result.value }
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

  if (state.type === 'loading') return <LedgerSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Sources"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }
  return (
    <SourceLedger
      sources={state.result.sources}
      limit={state.result.limit}
      onNavigate={onNavigate}
    />
  );
}

/**
 * The top-level Datastores ledger — every store this installation holds,
 * unscoped to any one App's workspace (§11's "top-level and attached, not a
 * field", read as a screen).
 *
 * Detach and Destroy are wired here rather than left to `DatastoreLedger`
 * calling `command` itself, for the same reason `WorkspaceScreen`'s Datastore
 * handlers are: the reload after a successful act belongs to whoever owns
 * the list being reloaded, and only this screen holds that state.
 */
function DatastoresScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; result: OutputOf<'listDatastores'> }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    command('listDatastores', {})
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', result: result.value }
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

  const handleDetach: DatastoreLedgerAct = async (datastoreId) => {
    try {
      const result = await command('detachDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Detaching failed',
      };
    }
  };

  const handleDestroy: DatastoreLedgerAct = async (datastoreId) => {
    try {
      const result = await command('destroyDatastore', { datastoreId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      setReloadToken((token) => token + 1);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Destroying failed',
      };
    }
  };

  if (state.type === 'loading') return <LedgerSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Datastores"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }
  return (
    <DatastoreLedger
      datastores={state.result.datastores}
      onNavigate={onNavigate}
      onDetach={handleDetach}
      onDestroy={handleDestroy}
    />
  );
}

function ArtifactsScreen({
  onNavigate,
}: {
  onNavigate: (path: string) => void;
}) {
  const [state, setState] = useState<
    | { type: 'loading' }
    | { type: 'error'; message: string }
    | { type: 'success'; result: OutputOf<'listArtifacts'> }
  >({ type: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    command('listArtifacts', {})
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { type: 'success', result: result.value }
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

  if (state.type === 'loading') return <LedgerSkeleton />;
  if (state.type === 'error') {
    return (
      <ScreenFailure
        title="Failed to load Artifacts"
        message={state.message}
        onRetry={() => setReloadToken((token) => token + 1)}
      />
    );
  }
  return (
    <ArtifactLedger
      artifacts={state.result.artifacts}
      limit={state.result.limit}
      onNavigate={onNavigate}
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
        available: readonly GrantedRepositoryView[];
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

  if (state.type === 'loading') return <SectionSkeleton rows={2} />;

  if (state.type === 'error') {
    return (
      <div className="py-6">
        <ErrorState
          title="Failed to load repositories"
          message={state.message}
          onRetry={handleRefresh}
        />
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
      } else if (result.value.pullRequestError !== null) {
        setActionError(
          `Connected, but the configuration pull request could not be opened: ${result.value.pullRequestError}`,
        );
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
    | { type: 'loading'; phase: CreationLoad }
    | { type: 'error'; message: string }
    | {
        type: 'success';
        targetOptions: readonly TargetOptionView[];
        repoOptions: readonly RepositoryOptionView[];
        repoGrant: readonly GrantedRepositoryView[];
        draft: import('../domain/creation-draft.ts').CreationDraftView;
      }
  >({ type: 'loading', phase: 'draft' });
  const [attempt, setAttempt] = useState(0);
  // React Strict Mode replays effects in development. Supplying the identity
  // makes both starts the same authenticated act instead of leaving an orphan.
  const startId = useRef(crypto.randomUUID());
  /** The draft on screen, so this screen's own URL rewrite is not navigation. */
  const loaded = useRef<string | null>(null);

  useEffect(() => {
    // The path naming the draft this screen started is the rewrite below
    // arriving back through the router. Reloading for it would re-run both
    // reads and throw away everything typed since — which is the whole of what
    // remounting on the id used to cost.
    if (draftId !== null && draftId === loaded.current) return;
    if (draftId === null && loaded.current !== null) {
      // `New App` pressed while a draft is open: a genuinely new one needs an
      // identity of its own, or `startCreationDraft` idempotently answers with
      // the draft already on screen.
      startId.current = crypto.randomUUID();
      loaded.current = null;
    }
    let live = true;
    setState({ type: 'loading', phase: 'draft' });
    const draftRequest =
      draftId === null
        ? command('startCreationDraft', { id: startId.current })
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
      setState({ type: 'loading', phase: 'options' });
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
      loaded.current = draftRes.value.id;
      setState({
        type: 'success',
        targetOptions: targetRes.value.options,
        repoOptions: repoRes.value.options,
        repoGrant: repoRes.value.available,
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
  }, [draftId, onNavigate, attempt]);

  if (state.type === 'loading') return <CreationSkeleton phase={state.phase} />;

  if (state.type === 'error') {
    return (
      <CreationLoadFailure
        message={state.message}
        onRetry={() => setAttempt((value) => value + 1)}
      />
    );
  }

  return (
    <NewApp
      key={state.draft.id}
      initial={state.draft}
      targets={state.targetOptions}
      repos={state.repoOptions}
      available={state.repoGrant}
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
