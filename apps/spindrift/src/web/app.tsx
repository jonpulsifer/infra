/**
 * The shell, and the client's whole route table.
 *
 * What is left here after the screens moved out beside the views they render:
 * whether there is anybody to show anything to, whether this installation has
 * been configured, which screen a path names, and the chrome around all three.
 */
import { Monitor, Moon, Sun } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Principal } from '../commands/types.ts';
import { readSession, signOut } from './auth-client.ts';
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
import { DatastoreScreen } from './views/operations/datastore-detail.tsx';
import { DatastoresScreen } from './views/operations/datastores.tsx';
import { DeploysScreen } from './views/operations/deploys.tsx';
import { OverviewScreen } from './views/operations/overview.tsx';
import { SettingsScreen } from './views/settings/layout.tsx';
import { ArtifactsScreen } from './views/supply-chain/artifacts.tsx';
import { BuildsScreen } from './views/supply-chain/builds.tsx';
import { SourcesScreen } from './views/supply-chain/sources.tsx';

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

  // The tab bar is where an operator holding three Deploys tells them apart.
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
 * The document title for a path — the tab's answer to "which one is this?".
 *
 * Derived from the path alone, mirroring `Screen` below branch for branch,
 * because the path already carries the human name: Apps route by name, Deploys
 * and Builds by the id their screens render as `#42`. Waiting for loaded data
 * would say the same words later, and leave every tab reading "Spindrift"
 * until its fetch returned.
 *
 * Exported for `test/web/screen-titles.test.ts`, which pins the mapping.
 */
export function titleOf(path: string): string {
  if (path.startsWith('/settings')) return 'Settings · Spindrift';
  if (
    path.startsWith('/targets') ||
    path.startsWith('/repos') ||
    path.startsWith('/storage')
  )
    return 'Settings · Spindrift';
  if (path.startsWith('/sources')) return 'Sources · Spindrift';
  if (path.startsWith('/artifacts')) return 'Artifacts · Spindrift';
  // No name in the path, so the tab says the noun. The id is a uuid: a title
  // holding one would be a title nobody can read a Datastore's name out of.
  if (path.startsWith('/datastores')) return 'Datastores · Spindrift';
  if (path.startsWith('/apps/new')) return 'New App · Spindrift';
  if (path.startsWith('/deploys')) {
    const deployId = path.replace(/^\/deploys\/?/, '');
    return deployId ? `Deploy #${deployId} · Spindrift` : 'Deploys · Spindrift';
  }
  if (path.startsWith('/builds')) {
    const buildId = path.replace(/^\/builds\/?/, '');
    return buildId ? `Build #${buildId} · Spindrift` : 'Builds · Spindrift';
  }
  if (path === '/' || path === '') return 'Spindrift';
  if (path === '/apps') return 'Apps · Spindrift';
  const appName = path.replace(/^\/apps\//, '').replace(/^\//, '');
  return `${appName} · Spindrift`;
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
