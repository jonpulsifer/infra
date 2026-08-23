/**
 * The App workspace (Task 40, §18).
 *
 * **Live state and URL lead**, then the placement — Target and the vessel it
 * is a surface on — then the Components this App is made of, then a dense
 * activity timeline. Components own the full width: they are what this screen
 * is a list of, and every act it offers is about one of them.
 *
 * A Datastore is a top-level noun (§11) with its own screens under
 * `/datastores`, which is where its lifetime lives. What this screen keeps is
 * the one line of it an App owns: which stores it reads through, and a picker
 * that attaches one more.
 *
 * Two things are stated here rather than hidden:
 *
 * - **The vessel is where the App is placed**, not something it was created
 *   with. It is read from the placed Target, so it is one fact rather than two
 *   that can disagree, and moving a Component moves it.
 * - **A `website` has no runtime**, one level down (§17, §18). Static files are
 *   served by the Target, so there is no process output — an honest empty state,
 *   not a disabled tab.
 * - **Config shows keys, never values** (§10). Core's store is write-only, so
 *   the section below Components is a list of names and a form that writes —
 *   there is nothing here that could show a secret it was handed by accident,
 *   because nothing here is ever handed one.
 *
 * **The hero is the running App, and the tabs are everything else.** §18 is
 * explicit that "the running App is the product, the pipeline is only how it got
 * there", and the screen used to contradict it by stacking six equal cards down
 * one column: config editing sat above the timeline, the live log was a
 * half-width card at the bottom, and the App's releases had no surface at all.
 * The hero and its diagnosis stay above the strip on every tab, because the
 * answer to "is my App up" is not a tab you can be on the wrong one of.
 */
import { ChevronRight, ExternalLink } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import type {
  ActivityEntry,
  AppDomainView,
  AppLockView,
  BuildRouteOptionView,
  ComponentView,
  DatastoreView,
  LogLine,
  PrerequisiteRowView,
  TargetListItem,
  WorkspaceView,
} from '../../../commands/views.ts';
import { isInFlight } from '../../../commands/views.ts';
import type {
  Auth,
  ComponentKind,
  Reach,
} from '../../../domain/desired-state.ts';
import { isLabel } from '../../../domain/naming.ts';
import { BUILD_ADAPTER } from '../../client/build-adapters.ts';
import { command, type InputOf, type TransportFailure } from '../../client.ts';
import {
  type AppDeletionControls,
  DeleteAppButton,
  DeleteAppDialog,
  useAppDeletion,
} from '../../components/delete-app.tsx';
import { DiagnosisPanel, DriftPanel } from '../../components/diagnosis.tsx';
import { EmptyState, LogPane } from '../../components/log-pane.tsx';
import { PhasePill } from '../../components/status.tsx';
import { Topology } from '../../components/topology.tsx';
import { useRead } from '../../poll.ts';
import { subscribeRuntime } from '../../stream-client.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, Eyebrow } from '../../ui/card.tsx';
import { Ref } from '../../ui/copy.tsx';
import { Declaration } from '../../ui/declaration.tsx';
import { Field, Input } from '../../ui/field.tsx';
import { Logo } from '../../ui/logo.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Tabs } from '../../ui/tabs.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { notify } from '../../ui/toast.tsx';
import { cn, normaliseUrl } from '../../ui/utils.ts';
import { UPLOAD_PATH } from '../../upload-path.ts';
import { DetailSkeleton, ScreenFailure, ScreenNotFound } from '../screen.tsx';
import {
  ComponentUploadButton,
  type StageArchive,
  type StagedUpload,
  type SubmitUpload,
} from './component-upload.tsx';
import {
  AUTH_NOTE,
  AUTHS,
  Choice,
  KIND_NOTE,
  KINDS,
  REACH_NOTE,
  REACHES,
} from './new/summary.tsx';
import { Releases } from './releases.tsx';

/**
 * Saving a Component's reach, as the screen above needs it answered.
 *
 * A promise rather than a fire-and-forget callback plus two state props: the
 * form has exactly one thing to say after the press — the Targets still placing
 * the old answer, or why it was refused — and threading that back as props
 * would put this card's transient state on the screen that owns the App.
 */
export type SetReach = (change: {
  readonly componentId: string;
  readonly reach: Reach;
  readonly auth: Auth;
}) => Promise<
  | { readonly ok: true; readonly pendingRelease: readonly string[] }
  | { readonly ok: false; readonly message: string }
>;

/**
 * Adding one Component to the App this screen already lists (§2), as the screen
 * above needs it answered.
 *
 * **Four fields, because the command takes four decisions.** `reach` and
 * `auth` have command-side defaults (`src/commands/components/create.ts:64-65`)
 * and `expose` is what a kind means rather than a choice (`create.ts:154-163`),
 * so a form offering any of them would be a second place for a default to be
 * wrong — and the card this form sits in is already where reach is edited.
 *
 * `schedule` travels only for a `job`, and is absent rather than empty for an
 * unscheduled one: `createComponentInput` is a `.strict()` discriminated union
 * (`create.ts:68-98`), so a schedule sent on a service is a validation failure
 * rather than a field nobody reads.
 *
 * `command` travels for every kind, and is the field that makes a second
 * Component worth adding at all: an App is one scope, so a sibling builds the
 * same image, and the entrypoint is the whole of what makes it a different
 * workload. Absent is the image's own, which is what every Component that says
 * nothing already means.
 *
 * No `targetId`, deliberately. `createComponent` does not write a placement
 * (`create.ts:123-138`) and `deployApp` fills it only while it is NULL
 * (`src/commands/apps/deploy.ts:529-534`) — a form that placed as well would
 * move that fact out of the one command that owns it.
 */
export type CreateComponent = (create: {
  readonly name: string;
  readonly kind: ComponentKind;
  readonly schedule?: string;
  readonly command?: string[];
}) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Moving a placed Component to another Target (§3, §10), as the screen above
 * needs it answered.
 *
 * **`supply` rides the move.** §10's sentence is "Place names the keys that
 * will not follow and demands them before the move commits", and
 * `placeComponent` puts the values on its own input for the reason its comment
 * states (`src/commands/components/place.ts:54-60`): "demands them before the
 * move commits" is only true if the move and the supply are one transaction
 * from the developer's side. So this seam carries them too, and the form above
 * it re-posts *one* call rather than writing config and trying again.
 *
 * **`demanded` is what the refusal names.** It comes back structurally rather
 * than as prose to be parsed — `placeComponent` attaches the keys as `issues`
 * — because the whole point of showing this refusal is to render a field per
 * key. The message stays core's sentence, unedited, because it says the thing
 * the fields cannot: that the values will not follow and that Spindrift never
 * reads one back.
 */
export type MoveComponent = (move: {
  readonly componentId: string;
  readonly targetId: string;
  readonly supply: readonly { readonly key: string; readonly value: string }[];
}) => Promise<
  | { readonly ok: true; readonly carried: readonly string[] }
  | {
      readonly ok: false;
      readonly message: string;
      readonly demanded: readonly string[];
    }
>;

/**
 * Retiring one (Component, Target) pair that still serves (§6, §13).
 *
 * By the pair, never by the Component: a move leaves two rows serving on
 * purpose, and "unplace this Component" would be a button that cannot say
 * which of them it means.
 *
 * `destroyed` travels because it is the difference between the two honest
 * sentences this act has — a workload was torn down, or there was never one to
 * tear down (`src/commands/components/unplace.ts:68-75`). A control that said
 * the first over the second would be claiming a teardown that never happened.
 */
export type UnplaceComponent = (pair: {
  readonly componentId: string;
  readonly targetId: string;
}) => Promise<
  | { readonly ok: true; readonly destroyed: boolean }
  | { readonly ok: false; readonly message: string }
>;

/**
 * Turning deploy-on-push on or off for this App (§15).
 *
 * Sends the state it wants rather than "flip it", which is what
 * `setAppAutoDeploy` takes and for the reason stated there: two presses racing
 * a toggle disagree about where they left it, and two presses racing a set do
 * not.
 */
export type SetAutoDeploy = (
  autoDeploy: boolean,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Holding this App's deploys with a reason, or letting them through again
 * (§6, `setAppLock`). `null` unlocks — the one act a rollback leaves for the
 * operator to do once the cause is fixed.
 */
export type SetLock = (
  reason: string | null,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * An App naming the build route it builds on, or clearing that choice back to
 * rank order (§4, §16), as the screen above needs it answered.
 *
 * The same shape {@link SetAutoDeploy} takes and for the same reason: the App
 * is bound by the screen above, and sending the value to set rather than a
 * flip means two presses racing a set do not disagree about where they left
 * it. `null` clears the choice — `setAppBuildRoute`'s own "leave it as it is
 * vs. clear it" distinction, carried through as a value this screen can send
 * rather than a second act.
 */
/** Naming the App's own shared address, as the screen needs it answered (§9). */
export type SetDomain = (choice: {
  /** The label, `@` for the zone itself, or null to have no name of its own. */
  readonly label: string | null;
  /** The zone to pin to, or null to take the first that serves. */
  readonly zone: string | null;
}) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export type SetBuildRoute = (
  route: string | null,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Starting one run of a job, as the screen above needs it answered (§17).
 *
 * The same shape {@link SetReach} takes and for the same reason: the press has
 * exactly one thing to say afterwards — it started, or here is the sentence the
 * command refused with — and threading that back as two props would put this
 * card's transient state on the screen that owns the App.
 *
 * `env` is this run's parameters, present only when the card has some to send;
 * what they may be called and what they may not shadow is `runComponent`'s to
 * refuse, and the sentence comes back through the same arm.
 */
export type RunJob = (
  env?: Readonly<Record<string, string>>,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Writing or removing config for the pair this workspace is showing (§10),
 * as the screen above needs it answered.
 *
 * One call for both, because `setConfig` itself takes entries and removals
 * together — there is no separate "edit" act, because setting a key that
 * already exists *is* the edit (core upserts and never reads the old value
 * back to compare against). `componentId`/`targetId` are not part of this
 * shape: the workspace has exactly one pair on screen, so the screen above
 * binds them once rather than asking every call here to restate it.
 */
export type SetConfig = (change: {
  readonly entries: readonly { key: string; value: string }[];
  readonly removals: readonly string[];
}) => Promise<
  | {
      readonly ok: true;
      readonly written: readonly string[];
      readonly removed: readonly string[];
      readonly notDeployed: string | null;
    }
  | { readonly ok: false; readonly message: string }
>;

/**
 * Attaching one Datastore to the App this screen is showing (§11).
 *
 * The App is bound by the screen above, exactly as it is for {@link SetConfig},
 * and every refusal is a sentence core composed — the attachment rules (one
 * store per engine per App, cluster-local placement) live in `attachDatastore`
 * and are not restated here. Detach and destroy are the ledger's: they need no
 * App, and a second place to end a Datastore's life is a second place for a
 * refusal to come back to.
 */
export type AttachDatastore = (
  datastoreId: string,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export function Workspace({
  view,
  onDeploy,
  onRebuild,
  deploying = false,
  onNavigate,
  deletion,
  onSetReach,
  onSetConfig,
  onSelectComponent,
  onCreateComponent,
  onMoveComponent,
  onUnplaceComponent,
  targets = [],
  onRunJob,
  onSetAutoDeploy,
  onSetLock,
  onSetBuildRoute,
  onSetDomain,
  onAttachDatastore,
  onFollowExecution,
  executionLines,
  tab = 'overview',
  onStageArchive,
  onUploadArchive,
}: {
  view: WorkspaceView;
  /**
   * Give one Component new bytes. Both or neither — staging without a command
   * to spend the digest on is a control that cannot finish.
   */
  onStageArchive?: StageArchive;
  onUploadArchive?: SubmitUpload;
  onDeploy?: () => void;
  /**
   * Ask for a Build outright.
   *
   * Its own control rather than a mode on the one above, because that button's
   * whole job is to decide — and a decision an operator can silently flip is
   * the substitution `deployApp` refuses to make. Always offered, never
   * conditional on what is built: "Rebuild" does exactly one thing whatever
   * the state, which is what makes it safe to press next to one that does not.
   */
  onRebuild?: () => void;
  deploying?: boolean;
  onNavigate?: (path: string) => void;
  /**
   * Absent where there is nothing to navigate back to after a delete — the
   * screen owns where the operator lands, so a caller that cannot answer that
   * question does not offer the act.
   */
  deletion?: AppDeletionControls;
  /**
   * Absent where reach is not editable from here — the fixture screens render
   * this view with no acts wired, and a form whose Save cannot be called is
   * worse than no form.
   */
  onSetReach?: SetReach;
  /**
   * Absent where config is not editable from here, for the same reason
   * {@link onSetReach} is — the fixture screens render this view with no acts
   * wired, and a form whose Save cannot be called is worse than no form.
   */
  onSetConfig?: SetConfig;
  /**
   * Show another Component of this App, by name.
   *
   * The Components list is the selector, because it is already the list of what
   * there is to look at. Absent where the screen reads a fixed view — a row
   * that could be pressed and changed nothing would be worse than a row that
   * cannot.
   */
  onSelectComponent?: (component: string) => void;
  /**
   * Add a Component to this App (§2). Absent where the screen wires no acts,
   * for the same reason {@link onSetReach} is.
   */
  onCreateComponent?: CreateComponent;
  /**
   * Move a Component to another Target, and retire a pair it has left (§3,
   * §10). Absent where the screen wires no acts, for the same reason
   * {@link onSetReach} is.
   */
  onMoveComponent?: MoveComponent;
  onUnplaceComponent?: UnplaceComponent;
  /**
   * The Targets this installation has, as `listTargets` reports them — the
   * list a move picks from.
   *
   * Empty rather than optional-and-absent, and the move control is not offered
   * over an empty one: a screen that has read no Targets cannot name one to
   * move to, and a disclosure that opens on nothing is the dead button
   * `SectionHeader` was hardened against, one level down.
   */
  targets?: readonly TargetListItem[];
  /**
   * Start one run of this App's job (§17). Absent where the screen wires no
   * acts, and absent for every Component that is not a job — the runtime card
   * is what decides, because it is the only branch with runs to start.
   */
  onRunJob?: RunJob;
  /**
   * Absent where deploy-on-push is not editable from here, for the same reason
   * {@link onSetReach} is. Also absent for an archive App — but that one the
   * view already says with `autoDeploy: null`, so the control is not rendered
   * at all rather than rendered dead.
   */
  onSetAutoDeploy?: SetAutoDeploy;
  /**
   * Absent where the lock is not editable from here, for the same reason
   * {@link onSetReach} is. The banner still renders read-only: a lock a
   * rollback set is a fact about the App whether or not this screen can lift it.
   */
  onSetLock?: SetLock;
  /**
   * Absent where the build route is not editable from here, for the same
   * reason {@link onSetReach} is. Also absent for an archive App — the view
   * says so with `buildRouteOptions: []`, so the picker is not rendered at
   * all rather than rendered on a Target it has nothing to check a level
   * against.
   */
  onSetBuildRoute?: SetBuildRoute;
  /** Absent where the App's address is not editable from here — the fixture
   * screens render this read-only, for the reason the others do. */
  onSetDomain?: SetDomain;
  /**
   * Attach a Datastore to this App (§11). Absent where the screen wires no
   * acts, for the same reason {@link onSetReach} is.
   */
  onAttachDatastore?: AttachDatastore;
  /** Follow one run's output, or nothing when the name is `null`. */
  onFollowExecution?: (execution: string | null) => void;
  /** The lines of whichever run is being followed. */
  executionLines?: readonly LogLine[];
  /**
   * Which tab the screen opens on.
   *
   * ponytail: the selection lives in this component rather than in the hash,
   * because `app.tsx` resolves an App by everything after `/apps/`, so
   * `#/apps/42/releases` reads as an App named `42/releases` and 404s. Making
   * each tab a real route is a two-line change *there* — strip the tab segment
   * before the read and key the screen on the App alone — and this prop is
   * what it would drive when it lands. Until then a tab is not linkable and
   * survives no reload.
   */
  tab?: WorkspaceTab;
}) {
  /*
    Which Component the rest of this screen is about — its runtime, its config
    keys, its placement and its release. `componentId` is the selection the
    read resolved; a view carrying none is showing the App's first Component,
    which is the same answer, so this is a lookup rather than a second guess at
    what the card below belongs to.
  */
  const selected =
    view.components.find((component) => component.id === view.componentId) ??
    view.components[0];

  const [current, setCurrent] = useState<WorkspaceTab>(tab);

  return (
    <Page width="reading">
      <PageHeader
        eyebrow={selected ? `${selected.kind} · ${selected.name}` : 'app'}
        title={view.app}
        actions={
          <>
            {/* And the id, because a name is not one: `deleteApp` resolves on
                the id, and a workspace that only knew what this App is called
                could not tell it apart from another App called the same. */}
            {deletion && view.appId ? (
              <DeleteAppButton
                appId={view.appId}
                name={view.app}
                deletion={deletion}
                label
              />
            ) : null}
            {/* Only where the selected Component answers somewhere: a job has
                no address, and `Open app` on an empty one reloads this
                screen. */}
            {view.url === '' ? null : (
              <Button variant="outline" asChild>
                <a
                  href={normaliseUrl(view.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open app <ExternalLink aria-hidden="true" />
                </a>
              </Button>
            )}
            {onRebuild ? (
              <Button
                variant="outline"
                onClick={onRebuild}
                disabled={deploying}
              >
                Rebuild
              </Button>
            ) : null}
            {/*
              "Deploy" whatever the kind. This button writes an intent, and for
              a job that places a CronJob triggered by nothing — it has never
              made anything run, and calling it `Run now` beside a button that
              does is the one label a reader cannot recover from. Running is on
              the runtime card, where the runs are (§17).
            */}
            <Button onClick={onDeploy} disabled={deploying}>
              {deploying ? 'Deploying...' : 'Deploy'}
            </Button>
          </>
        }
      />

      <Hero
        view={view}
        {...(selected === undefined ? {} : { component: selected })}
        onNavigate={onNavigate}
        {...(onSetAutoDeploy === undefined ? {} : { onSetAutoDeploy })}
        {...(onSetLock === undefined ? {} : { onSetLock })}
      />

      {/*
        Above the tabs, never inside one. §6 persists a diagnosis on red and
        records `drifted_at` when a converged release stops matching what is
        running, and both were readable only at `/deploys/:id` — so this screen
        said "has no release serving yet" over a failure whose reason was in
        hand, and "is live" over a release the platform had been refusing for
        two days. Neither is a thing an operator should have to be on the right
        tab to find out.
      */}
      {view.diagnosis ? (
        <DiagnosisPanel
          diagnosis={view.diagnosis}
          // The workspace does not know whether an older release is still up —
          // that is a second query about a Deploy this screen never reads — and
          // §6 does guarantee a failed deploy never touched exposure. The
          // release link says it properly, one press away.
          previousReleaseServing={false}
          url={view.url}
        />
      ) : null}
      {view.drift ? (
        <DriftPanel
          drift={view.drift}
          url={view.url}
          {...(onDeploy ? { onRedeploy: onDeploy } : {})}
          busy={deploying}
        />
      ) : null}

      <Tabs
        items={TABS}
        current={current}
        onSelect={(id) => setCurrent(id as WorkspaceTab)}
        label="Views of this App"
      />

      {current === 'overview' ? (
        <>
          {/*
            Above the Components list rather than below it, and this is the one
            place `components/flow.tsx`'s "the operator came for the rows" does
            not apply: that objection is about a *static explainer* stacked on
            top of live data. This is the live data, read a second way, and the
            question it answers — what is this App made of and what does it
            talk to — is the one you orient with before reading any row.
          */}
          <Topology components={view.components} datastores={view.datastores} />
          <Components
            components={view.components}
            archiveSourced={view.archiveSourced === true}
            {...(onStageArchive ? { onStageArchive } : {})}
            {...(onUploadArchive ? { onUploadArchive } : {})}
            {...(selected === undefined ? {} : { selectedId: selected.id })}
            {...(onSetReach === undefined ? {} : { onSetReach })}
            {...(onSelectComponent === undefined ? {} : { onSelectComponent })}
            {...(onCreateComponent === undefined ? {} : { onCreateComponent })}
            {...(onMoveComponent === undefined ? {} : { onMoveComponent })}
            {...(onUnplaceComponent === undefined
              ? {}
              : { onUnplaceComponent })}
            targets={targets}
            datastores={view.datastores}
            {...(onNavigate ? { onNavigate } : {})}
            {...(onAttachDatastore ? { onAttachDatastore } : {})}
          />
          {/*
            Empty rather than optional-and-absent for an archive App and for
            one with no Target placed yet — `getAppWorkspace` says so with
            `buildRouteOptions: []`, and the card is not rendered on nothing
            to pick from rather than rendered with a lone "Rank order" tile
            that has no other routes to rank against.
          */}
          {view.buildRouteOptions.length > 0 && onSetBuildRoute ? (
            <BuildRoutePicker
              buildRoute={view.buildRoute}
              options={view.buildRouteOptions}
              onSetBuildRoute={onSetBuildRoute}
            />
          ) : null}
          <div className="grid gap-4 md:grid-cols-2">
            {/*
              Every entry the view carries, un-sliced. `getAppWorkspace` bounds
              the query that produces them, and a second bound here would be a
              number that can silently disagree with it — a limit raised on the
              server and not here reads as applied and is not.
            */}
            <Activity entries={view.activity} onNavigate={onNavigate} />
            <Runtime
              view={view}
              {...(selected === undefined ? {} : { component: selected.name })}
              onNavigate={onNavigate}
              {...(onRunJob ? { onRun: onRunJob } : {})}
              {...(onFollowExecution ? { onFollowExecution } : {})}
              {...(executionLines ? { executionLines } : {})}
            />
          </div>
        </>
      ) : null}

      {current === 'releases' ? (
        view.appId === undefined ? (
          <EmptyState title="This App has no id to read releases by.">
            The screen was handed a view without one, which is the fixture shape
            — a live workspace always carries it.
          </EmptyState>
        ) : (
          <Releases app={view.appId} {...(onNavigate ? { onNavigate } : {})} />
        )
      ) : null}

      {current === 'config' ? (
        <>
          {/*
            Above the variables, because it is the configuration that decides
            what gets built at all — §5's scope and its `spindrift.yaml` — and
            §10's keys only decide what the result runs with. Keyed by id, not
            by name, for the reason `getAppWorkspace` resolves by id: two Apps
            may wear one name.
          */}
          {view.appId === undefined ? null : <SourceSection app={view.appId} />}
          {/*
            Above the variables and below the source, which is the order this
            block already argues for: what gets built, then what the result is
            called, then what it runs with. The address is the App's, and the
            keys below it are one Component's.
          */}
          {view.domain === undefined ? null : (
            <DomainSection
              domain={view.domain}
              {...(onSetDomain === undefined ? {} : { onSetDomain })}
            />
          )}
          <ConfigSection
            configKeys={view.configKeys}
            {...(selected === undefined ? {} : { component: selected.name })}
            {...(onSetConfig === undefined ? {} : { onSetConfig })}
          />
        </>
      ) : null}
    </Page>
  );
}

/**
 * The three views of one App.
 *
 * Three rather than the six the audit sketched, because a tab is only worth its
 * click where the thing behind it is a *different question*. Releases is one
 * (`listDeploys`, which nothing in the browser had ever called) and Config is
 * one (§10's write-only store, which has no business sitting above the
 * timeline). Logs and Components are both answers to "what is this App doing
 * right now", which is Overview, and splitting them would make the common
 * visit three clicks instead of none.
 */
export type WorkspaceTab = 'overview' | 'releases' | 'config';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'releases', label: 'Releases' },
  { id: 'config', label: 'Config' },
] as const satisfies readonly { id: WorkspaceTab; label: string }[];

/**
 * What the hero says about the Component the screen is showing.
 *
 * Named rather than called "Your App", because everything beside this sentence
 * — the phase pill, the address, the release, the placement — is one
 * Component's: an App whose `job` sits behind a serving `service` would
 * otherwise read "Your App has no release serving yet" over a service that is
 * serving, and "Your App is live" over a CronJob the moment it is placed.
 *
 * A Component with no address is stated as deployed rather than as serving.
 * Every job is one, and so is a service kept off the network — neither of them
 * has anything an operator could open, and "no release serving yet" reads as a
 * release that failed rather than one that was never meant to serve.
 */
function heroHeadline(view: WorkspaceView, component?: ComponentView): string {
  const subject = component?.name ?? 'Your App';
  if (view.url === '') {
    return view.phase === 'LIVE'
      ? `${subject} is deployed`
      : `${subject} has no release yet`;
  }
  return view.urlLive
    ? `${subject} is live`
    : `${subject} has no release serving yet`;
}

/** Live state and URL on the left; placement on the right. */
function Hero({
  view,
  component,
  onNavigate,
  onSetAutoDeploy,
  onSetLock,
}: {
  view: WorkspaceView;
  /** The Component this card is about. Absent for an App with none yet. */
  component?: ComponentView;
  onNavigate?: (path: string) => void;
  onSetAutoDeploy?: SetAutoDeploy;
  onSetLock?: SetLock;
}) {
  // What `release` names: the Deploy where there is one, the Build that is
  // still the whole of the attempt where there is not.
  const releasePath =
    view.latestDeployId !== undefined
      ? `/deploys/${view.latestDeployId}`
      : view.latestBuildId !== undefined
        ? `/builds/${view.latestBuildId}`
        : null;

  return (
    <Card className="flex flex-wrap items-start gap-6 px-5 py-5">
      {/*
        Above both columns, because it is about the App and not about either
        half: a locked App has a placement and a release like any other, and
        what has changed is that the Deploy button above will refuse.
      */}
      {view.lock ? (
        <LockBanner
          lock={view.lock}
          {...(onSetLock === undefined ? {} : { onSetLock })}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <PhasePill phase={view.phase} />
        <p className="text-xl font-semibold tracking-tight">
          {heroHeadline(view, component)}
        </p>
        {/* No address, no link: `normaliseUrl('')` is `''`, and an anchor
            carrying that reloads the screen it is on. */}
        {view.url === '' ? null : (
          <a
            href={normaliseUrl(view.url)}
            className={cn(
              'font-mono text-[15px]',
              view.urlLive
                ? 'border-b border-current text-accent-foreground'
                : 'pointer-events-none text-muted-foreground',
            )}
          >
            {view.url}
          </a>
        )}
        {/*
          The release is a link because it is a thing, not a label: §2's Deploy
          is Heroku's Release, and the attempt that produced what is running is
          one press away from the screen that says how it went.

          Before there is a Deploy the same is true of the Build: the create
          flow starts one, `release` names it, and it was the one word on this
          screen that stated a running attempt and led nowhere.
        */}
        {releasePath && onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(releasePath)}
            className="self-start text-xs text-subtle hover:text-foreground"
          >
            {view.release} →
          </button>
        ) : (
          <Eyebrow>{view.release}</Eyebrow>
        )}
        {/*
          What shipped, and when. A phase pill with no date on it cannot tell
          four minutes apart from four months, and the commit behind a running
          App was reachable only by opening the release. Both are columns on the
          Deploy row this screen already reads.
        */}
        {view.commit || view.at ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {view.commit ? (
              <Ref
                value={view.commit}
                kind="commit"
                headline={view.commitMessage}
              />
            ) : null}
            {view.at ? (
              <Timestamp at={view.at} when={view.when} className="font-mono" />
            ) : null}
          </div>
        ) : null}
        {/*
          Pushed but not live (§15). The adopted commit and the serving one
          were on different tabs and nothing joined them. What happens next
          depends on the switch beside placement: a push App has a deploy on
          the way unless the lock is holding it, and a manual one needs the
          Rebuild press — Deploy alone would place the artifact already built.
        */}
        {view.source?.pending ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{view.source.branch}</span> is at{' '}
            <Ref value={view.source.pending.commit} kind="commit" />, live is{' '}
            {view.commit ? (
              <Ref value={view.commit} kind="commit" />
            ) : (
              'nothing'
            )}
            {' — '}
            {view.lock
              ? 'held by the lock'
              : view.autoDeploy
                ? 'a deploy is coming'
                : 'press Rebuild to ship it'}
          </p>
        ) : null}
      </div>

      <div className="ml-auto flex flex-col items-end gap-1 text-right">
        <Eyebrow>Placement</Eyebrow>
        <p className="font-semibold">{view.target}</p>
        <p className="font-mono text-xs text-muted-foreground">
          on {view.vessel}
        </p>
        <Prerequisites
          met={view.prerequisitesMet}
          unmet={view.unmetPrerequisites ?? []}
          {...(view.targetId && onNavigate
            ? { onOpenTarget: () => onNavigate('/targets') }
            : {})}
        />
        {/*
          Beside placement rather than in the header, because it is not an act:
          the header holds the two buttons that make something happen now, and
          a switch that changes what happens *next time* sitting between them
          is the one misread that costs a surprise deploy.

          Rendered only where the App can receive a push at all — `autoDeploy`
          is `null` for an archive App, and a disabled switch would offer a
          choice that does not exist.
        */}
        {view.autoDeploy !== null && onSetAutoDeploy ? (
          <AutoDeployToggle
            autoDeploy={view.autoDeploy}
            onSetAutoDeploy={onSetAutoDeploy}
          />
        ) : null}
        {/* The hold, where it can be set by hand. Lifting one is the banner's. */}
        {view.lock === undefined && onSetLock ? (
          <LockControl onSetLock={onSetLock} />
        ) : null}
      </div>
    </Card>
  );
}

/**
 * The hold on this App's deploys, and the one act that lifts it (§6).
 *
 * Read-only without `onSetLock`, never hidden: a lock a rollback set is why
 * the Deploy button is about to refuse, and that is true on every screen that
 * shows the App, including the ones that wire no acts.
 */
function LockBanner({
  lock,
  onSetLock,
}: {
  lock: AppLockView;
  onSetLock?: SetLock;
}) {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const unlock = async () => {
    if (onSetLock === undefined) return;
    setBusy(true);
    setRefusal(null);
    try {
      const result = await onSetLock(null);
      if (!result.ok) setRefusal(result.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex basis-full flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/40 bg-warning-soft px-3.5 py-2.5 text-[12.5px]">
      <span className="font-mono text-[13px] font-semibold text-warning">
        LOCKED
      </span>
      <span className="text-foreground">{lock.reason}</span>
      <span className="text-subtle" title={lock.at}>
        by {lock.by}, {lock.since}
      </span>
      {onSetLock ? (
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={unlock}
          disabled={busy}
        >
          {busy ? 'Unlocking…' : 'Unlock'}
        </Button>
      ) : null}
      {refusal ? (
        <p className="basis-full text-xs text-destructive">{refusal}</p>
      ) : null}
    </div>
  );
}

/**
 * Setting the hold by hand — "nothing changes here over the weekend" without
 * turning deploy-on-push off and forgetting to turn it back on.
 *
 * A reason is required because the banner prints it to whoever meets the
 * refusal next, and that person may not be the one who set it.
 */
function LockControl({ onSetLock }: { onSetLock: SetLock }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const submit = async () => {
    setSaving(true);
    setRefusal(null);
    try {
      const result = await onSetLock(reason.trim());
      if (!result.ok) {
        setRefusal(result.message);
      } else {
        setOpen(false);
        setReason('');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-xs text-muted-foreground hover:text-foreground"
      >
        Lock deploys
      </button>
    );
  }

  return (
    <form
      className="mt-1 flex flex-col items-end gap-1.5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="why nothing should go out"
        aria-label="Lock reason"
        className="w-64"
      />
      <div className="flex gap-1.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(false)}
          disabled={saving}
        >
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={saving || !reason.trim()}>
          {saving ? 'Locking…' : 'Lock'}
        </Button>
      </div>
      {refusal ? (
        <p className="max-w-[22rem] text-left text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Which prerequisite is unmet, rather than that one is.
 *
 * `prerequisitesMet` is a boolean derived from "every catalogued row met", so
 * the screen was showing the conclusion with the evidence thrown away — "A
 * prerequisite is unmet" on the one screen where the operator is asking *which*
 * is a dead end, and the App will not deploy until it is answered.
 *
 * A native `<details>` rather than the `Collapsible` the panels above use: this
 * is three lines of text with no initial state to derive and no animation worth
 * the state to drive it, and the element does the whole job — including opening
 * before hydration, which matters on the one card a reader is staring at while
 * the rest of the page is still arriving.
 *
 * The remediation is deliberately not here. §13 composes the change that clears
 * a row from the manifest and the boundary, which the Targets screen has and
 * this one does not; a thinner generator here would be a second answer to a
 * question that already has one. So it names the blockage and points there.
 */
function Prerequisites({
  met,
  unmet,
  onOpenTarget,
}: {
  met: boolean;
  unmet: readonly PrerequisiteRowView[];
  onOpenTarget?: () => void;
}) {
  if (met) {
    return (
      <p className="text-xs text-muted-foreground">All prerequisites passing</p>
    );
  }

  if (unmet.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        A prerequisite is unmet
        {onOpenTarget ? (
          <>
            {' — '}
            <button
              type="button"
              onClick={onOpenTarget}
              className="underline hover:text-foreground"
            >
              open the Target
            </button>
          </>
        ) : null}
      </p>
    );
  }

  return (
    <details className="text-right text-xs text-muted-foreground">
      <summary className="cursor-pointer text-warning hover:text-foreground">
        {unmet.length === 1
          ? '1 prerequisite unmet'
          : `${unmet.length} prerequisites unmet`}
      </summary>
      <ul className="mt-1.5 flex flex-col gap-1">
        {unmet.map((row) => (
          <li key={row.name}>
            <span className="font-mono">{row.name}</span>
            {row.detail ? <> — {row.detail}</> : null}
          </li>
        ))}
      </ul>
      {onOpenTarget ? (
        <button
          type="button"
          onClick={onOpenTarget}
          className="mt-1.5 underline hover:text-foreground"
        >
          Open the Target to clear these
        </button>
      ) : null}
    </details>
  );
}

/**
 * Deploy on push, on or off (§15).
 *
 * **Optimistic, and it says so when it was wrong.** The press flips the label
 * immediately and puts it back if the command refuses — a switch that waits for
 * a round trip before moving reads as broken, and this one is cheap to undo.
 *
 * No confirmation. Turning it *on* is the direction with consequences, and the
 * consequence is a deploy that would have happened anyway the moment somebody
 * pressed Deploy — §15's dispatcher calls the same `deployApp`, so nothing here
 * can do something the button above it could not.
 */
function AutoDeployToggle({
  autoDeploy,
  onSetAutoDeploy,
}: {
  autoDeploy: boolean;
  onSetAutoDeploy: SetAutoDeploy;
}) {
  const [on, setOn] = useState(autoDeploy);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const flip = async () => {
    const wanted = !on;
    setOn(wanted);
    setSaving(true);
    setRefusal(null);
    try {
      const result = await onSetAutoDeploy(wanted);
      if (!result.ok) {
        setOn(!wanted);
        setRefusal(result.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-1 flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={flip}
        disabled={saving}
        aria-pressed={on}
        className={cn(
          'rounded-md border px-2 py-1 text-xs transition-colors',
          on
            ? 'border-accent/40 bg-accent-soft text-accent-foreground'
            : 'border-border-soft text-muted-foreground hover:text-foreground',
        )}
      >
        Deploy on push: {on ? 'on' : 'off'}
      </button>
      {refusal ? (
        <p className="max-w-[22rem] text-left text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Which route this App builds on (§4, §16).
 *
 * A grid of `Choice` tiles rather than a dropdown — the same primitive the
 * Target picker in the create flow uses for "pick one of a few rich options",
 * because a native `<select>` cannot wear a logo, a level badge, and a
 * refusal sentence the way a disabled tile can. One extra tile, "Rank order",
 * answers `route: null` — the App's default, back to the installation's own
 * arrangement.
 *
 * **Optimistic, and it says so when it was wrong** — the same posture
 * {@link AutoDeployToggle} takes: the press selects its tile immediately and
 * reverts if `setAppBuildRoute` refuses, with its sentence shown beneath the
 * grid.
 */
function BuildRoutePicker({
  buildRoute,
  options,
  onSetBuildRoute,
}: {
  buildRoute: string | null;
  options: readonly BuildRouteOptionView[];
  onSetBuildRoute: SetBuildRoute;
}) {
  const [current, setCurrent] = useState(buildRoute);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const choose = async (route: string | null) => {
    const previous = current;
    setCurrent(route);
    setSaving(true);
    setRefusal(null);
    try {
      const result = await onSetBuildRoute(route);
      if (!result.ok) {
        setCurrent(previous);
        setRefusal(result.message);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <SectionHeader eyebrow="Build" title="Builder" />
      <CardContent className="flex flex-col gap-3 pt-0">
        <div className="grid gap-2 sm:grid-cols-2">
          <Choice
            selected={current === null}
            disabled={saving}
            title="Rank order"
            note="No preference — the installation's own arrangement decides."
            onClick={() => choose(null)}
          />
          {options.map((option) => {
            const platform = option.adapter
              ? BUILD_ADAPTER[option.adapter]
              : undefined;
            return (
              <Choice
                key={option.name}
                selected={current === option.name}
                disabled={saving || !option.eligible}
                onClick={() => choose(option.name)}
              >
                <div className="flex flex-wrap items-center gap-2">
                  {platform ? (
                    <Logo name={platform.logo} className="size-4" />
                  ) : null}
                  <span className="text-sm font-semibold">
                    {platform?.label ?? option.name}
                  </span>
                  <Badge tone="idle" className="ml-auto">
                    {`SLSA L${option.level}`}
                  </Badge>
                </div>
                <span
                  className={
                    option.eligible
                      ? 'font-mono text-xs text-muted-foreground'
                      : 'text-xs text-destructive'
                  }
                >
                  {option.eligible ? option.name : option.reason}
                </span>
              </Choice>
            );
          })}
        </div>
        {refusal ? (
          <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {refusal}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * A section's label, and its one action where it has one.
 *
 * `action` is optional because not every section does something: the timeline
 * is read by clicking its own entries, and a "View all" beside it would be a
 * button whose absence of a destination the reader discovers by pressing it.
 */
function SectionHeader({
  eyebrow,
  title,
  action,
  onAction,
}: {
  eyebrow: string;
  title: string;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <CardHeader>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 className="text-base font-semibold tracking-tight">{title}</h2>
      </div>
      {/*
        Both, or neither. Rendering the verb on `action` alone is what made
        buttons on this screen do nothing when pressed: `Add Component` never
        had a handler at all, and the runtime card's own verb loses one
        whenever the Component has no release to open. A section that cannot
        answer its verb does not offer it.
      */}
      {action && onAction ? (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={onAction}
        >
          {action}
        </Button>
      ) : null}
    </CardHeader>
  );
}

/** One row of a peer section — a badge, two lines, and an affordance. */
function Row({
  badge,
  title,
  detail,
  trailing,
  onSelect,
  selected,
}: {
  badge: ReactNode;
  title: string;
  detail: string;
  trailing?: ReactNode;
  /**
   * Make the row itself the act of picking it.
   *
   * The badge and the two lines become the button and `trailing` stays outside
   * it, because a row's own act sits there — nesting one button inside another
   * is not something a browser renders, so the region that selects has to stop
   * short of it.
   */
  onSelect?: () => void;
  selected?: boolean;
}) {
  const body = (
    <>
      {badge}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="truncate text-xs text-muted-foreground">{detail}</p>
      </div>
    </>
  );

  return (
    <div
      className={cn(
        'flex items-center gap-3 border-b border-border-soft py-2.5 last:border-b-0',
        selected && 'border-l-2 border-l-accent pl-2',
      )}
    >
      {onSelect ? (
        <button
          type="button"
          aria-pressed={selected}
          onClick={onSelect}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left hover:bg-secondary/40"
        >
          {body}
        </button>
      ) : (
        body
      )}
      {/*
        The chevron is a claim that pressing the row goes somewhere, so it is
        drawn only where the row can be pressed. It used to be the default on
        every row with no trailing control — config keys, job runs — each of
        which advertised a navigation it did not have.
      */}
      {trailing ??
        (onSelect ? (
          <ChevronRight
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : null)}
    </div>
  );
}

/**
 * Every Component of this App, and which one the screen is showing.
 *
 * **The list is the selector.** The runtime card, the Run now control and the
 * config keys all belong to one Component, and this is the only place that says
 * which — an App whose `job` sits behind its `service` reaches that job's runs
 * by the row being pressed here, and reaches them nowhere else. The row being
 * shown is marked, because a screen rendering a second Component's runs with
 * nothing saying whose they are is worse than one that cannot render them.
 */
/**
 * What one Component's row says, now that the row knows where it is.
 *
 * The hero states the placement of the *selected* Component, so on an App with
 * three of them the other two's placement and address were unobtainable without
 * pressing each row in turn — which is the one thing a list of Components exists
 * to spare a reader. Each of the three new facts is stated only where the
 * Component has it: one that has never been placed has no Target, a job has no
 * address, and neither should read as a blank where a value goes.
 */
function componentDetail(component: ComponentView): string {
  const parts = [
    component.phase,
    `${component.reach}${component.auth === 'proxy' ? ' + auth' : ''}`,
    component.artifact,
  ];
  if (component.target) parts.push(component.target);
  if (component.url) parts.push(component.url);
  if (component.when) parts.push(component.when);
  return parts.join(' · ');
}

function Components({
  components,
  selectedId,
  onSetReach,
  onSelectComponent,
  onCreateComponent,
  onMoveComponent,
  onUnplaceComponent,
  targets = [],
  archiveSourced = false,
  onStageArchive,
  onUploadArchive,
  datastores = [],
  onNavigate,
  onAttachDatastore,
}: {
  components: readonly ComponentView[];
  /** Whether uploading is this App's only way to a new release. */
  archiveSourced?: boolean;
  onStageArchive?: StageArchive;
  onUploadArchive?: SubmitUpload;
  /** The row this screen's runtime, config and placement are about. */
  selectedId?: string;
  onSetReach?: SetReach;
  onSelectComponent?: (component: string) => void;
  onCreateComponent?: CreateComponent;
  onMoveComponent?: MoveComponent;
  onUnplaceComponent?: UnplaceComponent;
  targets?: readonly TargetListItem[];
  /**
   * Every Datastore this App reads through, plus the unattached ones it could
   * (§11). One line under the Components rather than a card beside them: a
   * Datastore is not a peer of the thing this screen is a list of, and the
   * card that said it was took half the width to state at most a handful of
   * names.
   */
  datastores?: readonly DatastoreView[];
  /** Where a Datastore's name goes when it is pressed — its own screen. */
  onNavigate?: (path: string) => void;
  onAttachDatastore?: AttachDatastore;
}) {
  /*
    Two disclosures rather than one, because they are two acts on the same row
    and neither is a mode of the other: reach is written on the Component and
    takes effect on the next release, and a move is written on the placement and
    takes effect now. One `editing` slot shared between them would make opening
    Move look like cancelling Reach.
  */
  const [editing, setEditing] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Both, or the row shows neither: a Component can be moved and the pair it
  // left retired, and half of that pair of acts is a screen that can strand a
  // workload it cannot then tear down.
  const movable =
    onMoveComponent && onUnplaceComponent && targets.length > 0
      ? { onMoveComponent, onUnplaceComponent }
      : null;

  return (
    <Card>
      {/*
        The verb, with the handler that answers it — the both-or-neither rule
        `SectionHeader` enforces, satisfied rather than dodged. An App gains its
        second Component here because this is the list of what it has: §2's "one
        App to many Components" had exactly one door, the create flow, and a
        `job` beside a `service` was reachable only by posting to the command
        endpoint. The form is on this screen rather than behind a route for the
        same reason `ReachEditor` is: what it writes is a row this card is
        already showing.
      */}
      <SectionHeader
        eyebrow="App structure"
        title="Components"
        {...(onCreateComponent
          ? {
              action: adding ? 'Close' : 'Add Component',
              onAction: () => setAdding((current) => !current),
            }
          : {})}
      />
      <CardContent className="pt-0">
        {onCreateComponent && adding ? (
          <NewComponentForm
            onCreateComponent={onCreateComponent}
            onDone={() => setAdding(false)}
          />
        ) : null}
        {/* The length guard every sibling card has. A brand-new App rendered
            an empty card under a dead button. The second sentence follows the
            verb: where one is offered it is the answer, and where none is —
            the fixture screens, which wire no acts — the create flow is. */}
        {components.length === 0 ? (
          <EmptyState title="This App has no Components yet.">
            A Component is what gets built and placed.{' '}
            {onCreateComponent
              ? 'Add Component declares one.'
              : 'The create flow declares the first one.'}
          </EmptyState>
        ) : null}
        {components.map((component) => {
          /*
            A first placement is not a move. `deployApp` writes `placedTargetId`
            while it is NULL (`src/commands/apps/deploy.ts:529-534`), which is
            how a Component the Components card just added gets placed at all —
            so offering Move on one that has never been placed would be a second
            answer to which Target it lives on, and `placeComponent` would be
            the act that decided it. A pair that still serves is the evidence
            there is a placement to move.
          */
          const moves =
            movable && (component.serving?.length ?? 0) > 0 ? movable : null;
          return (
            <div key={component.name}>
              <Row
                badge={<Badge tone="accent">{component.kind}</Badge>}
                title={component.name}
                detail={componentDetail(component)}
                selected={component.id === selectedId}
                {...(onSelectComponent === undefined
                  ? {}
                  : { onSelect: () => onSelectComponent(component.name) })}
                trailing={
                  onSetReach || moves || (onStageArchive && onUploadArchive) ? (
                    <div className="relative flex shrink-0 items-center gap-2">
                      {onStageArchive && onUploadArchive ? (
                        <ComponentUploadButton
                          component={component}
                          archiveSourced={archiveSourced}
                          onStage={onStageArchive}
                          onSubmit={onUploadArchive}
                        />
                      ) : null}
                      {onSetReach ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setEditing((current) =>
                              current === component.id ? null : component.id,
                            )
                          }
                        >
                          {editing === component.id ? 'Cancel' : 'Reach'}
                        </Button>
                      ) : null}
                      {moves ? (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            setPlacing((current) =>
                              current === component.id ? null : component.id,
                            )
                          }
                        >
                          {placing === component.id ? 'Cancel' : 'Move'}
                        </Button>
                      ) : null}
                    </div>
                  ) : undefined
                }
              />
              {onSetReach && editing === component.id ? (
                <ReachEditor
                  component={component}
                  onSetReach={onSetReach}
                  onDone={() => setEditing(null)}
                />
              ) : null}
              {moves && placing === component.id ? (
                <PlacementEditor
                  component={component}
                  targets={targets}
                  onMoveComponent={moves.onMoveComponent}
                  onUnplaceComponent={moves.onUnplaceComponent}
                  onDone={() => setPlacing(null)}
                />
              ) : null}
            </div>
          );
        })}
        <DatastoreLine
          datastores={datastores}
          {...(onNavigate ? { onNavigate } : {})}
          {...(onAttachDatastore ? { onAttachDatastore } : {})}
        />
      </CardContent>
    </Card>
  );
}

/**
 * The Datastores this App reads through, and the picker that attaches one more.
 *
 * One line, not a section. What an App owns of a Datastore is the attachment;
 * everything else — creating, detaching, destroying, and the object itself —
 * is the ledger's, one press away through the name.
 *
 * The picker lists only unattached stores because those are the only ones
 * `attachDatastore` accepts, and it is withheld entirely where there are none
 * to pick: a select with nothing in it is the dead control the both-or-neither
 * rule exists to prevent. Every other refusal is core's — placement and the
 * one-per-engine rule are its to state, not this screen's to predict.
 */
function DatastoreLine({
  datastores,
  onNavigate,
  onAttachDatastore,
}: {
  datastores: readonly DatastoreView[];
  onNavigate?: (path: string) => void;
  onAttachDatastore?: AttachDatastore;
}) {
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  const attached = datastores.filter((row) => row.attachedTo !== null);
  const free = datastores.filter((row) => row.attachedTo === null);
  const pick = chosen === '' ? free[0]?.id : chosen;

  if (attached.length === 0 && (free.length === 0 || !onAttachDatastore)) {
    return null;
  }

  const attach = () => {
    if (!onAttachDatastore || pick === undefined) return;
    setBusy(true);
    setRefusal(null);
    void onAttachDatastore(pick).then((result) => {
      setBusy(false);
      if (!result.ok) setRefusal(result.message);
    });
  };

  return (
    <div className="mt-3 border-t border-border-soft pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">Datastores</span>
        {attached.length === 0 ? (
          <span>none attached</span>
        ) : (
          attached.map((datastore) => (
            <button
              key={datastore.id}
              type="button"
              disabled={!onNavigate}
              onClick={() => onNavigate?.(`/datastores/${datastore.id}`)}
              className="rounded-full border border-border-soft px-2 py-0.5 font-mono text-foreground enabled:hover:border-input disabled:cursor-default"
            >
              {datastore.name} · {datastore.engine}
              {datastore.phase === 'LIVE' ? '' : ` · ${datastore.phase}`}
            </button>
          ))
        )}
        {onAttachDatastore && free.length > 0 ? (
          <span className="ml-auto flex items-center gap-2">
            <select
              name="attach-datastore"
              aria-label="Datastore to attach"
              value={pick ?? ''}
              disabled={busy}
              onChange={(event) => setChosen(event.currentTarget.value)}
              className="h-8 rounded-sm border border-input bg-background px-2 font-mono text-xs text-foreground"
            >
              {free.map((datastore) => (
                <option key={datastore.id} value={datastore.id}>
                  {datastore.name} · {datastore.engine}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={attach}
            >
              {busy ? 'Attaching…' : 'Attach'}
            </Button>
          </span>
        ) : null}
      </div>
      {refusal ? (
        <p className="mt-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
      <p className="pt-2 text-xs text-muted-foreground">
        A Postgres connection arrives as DATABASE_URL and a Valkey one as
        REDIS_URL, on the next Deploy — attaching writes a row, it does not
        restart what is running.
      </p>
    </div>
  );
}

/**
 * Declaring one more Component of this App (§2).
 *
 * **A name, a kind, and — for a job — a schedule.** Everything else a
 * `components` row carries either has a command-side default or is decided by
 * the kind, and {@link CreateComponent} argues that at the seam. The kind tiles
 * are the creation flow's own, so a developer meets the three kinds once and in
 * the same words rather than per screen.
 *
 * **What it writes is a row, not a release.** `createComponent` inserts the
 * Component and stops: nothing is built, nothing is placed, and no Target is
 * serving it — placement is what the first Deploy writes
 * (`src/commands/apps/deploy.ts:529-534`). So the sentence on success names the
 * two things that have not happened yet and points at the button that does
 * them, for the reason {@link ReachEditor}'s does: a screen reading "done" over
 * an act the platform has not been asked for is the one failure a form of this
 * shape can produce.
 *
 * Exported, and `kind` is the disclosure's opening selection rather than a
 * fixed one, because `test/harness/dom.ts` cannot press a tile — the job branch
 * of this form has copy of its own, and a test that could only reach the
 * default would be asserting that a service renders while the conditional field
 * goes unread.
 */
export function NewComponentForm({
  onCreateComponent,
  onDone,
  kind: initialKind = 'service',
}: {
  onCreateComponent: CreateComponent;
  onDone: () => void;
  kind?: ComponentKind;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ComponentKind>(initialKind);
  const [schedule, setSchedule] = useState('');
  const [entrypoint, setEntrypoint] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'created'; readonly name: string }
    | { readonly kind: 'refused'; readonly message: string }
    | null
  >(null);

  const save = async () => {
    setSaving(true);
    setOutcome(null);
    const created = name.trim();
    try {
      const result = await onCreateComponent({
        name: created,
        kind,
        // Absent for every other kind, and for a job that names no schedule:
        // the command's union is `.strict()`, and an unscheduled job is one
        // that says nothing rather than one that says empty.
        ...(kind === 'job' && schedule.trim() !== ''
          ? { schedule: schedule.trim() }
          : {}),
        ...(entrypoint.trim() === '' ? {} : { command: argvOf(entrypoint) }),
      });
      if (result.ok) {
        setOutcome({ kind: 'created', name: created });
        setName('');
        setSchedule('');
        setEntrypoint('');
      } else {
        setOutcome({ kind: 'refused', message: result.message });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border-soft pb-3">
      <Field
        name="component-name"
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="worker"
        hint="Lowercase DNS label — it appears in this Component's hostname and in its own registry repository."
      />
      <div className="grid gap-2 sm:grid-cols-3">
        {KINDS.map((option) => (
          <Choice
            key={option}
            selected={kind === option}
            title={option}
            note={KIND_NOTE[option]}
            onClick={() => setKind(option)}
          />
        ))}
      </div>
      {/*
        §2: "`schedule` is a field on a job, not a kind." Asked only where the
        kind has an answer for it, which is the same thing `ReachEditor` does
        with `auth` at `reach: none` — a refusal said by not asking rather than
        after the press.
      */}
      {kind === 'job' ? (
        <Field
          name="component-schedule"
          label="Schedule"
          value={schedule}
          onChange={(event) => setSchedule(event.target.value)}
          placeholder="0 3 * * *"
          hint="Five cron fields. Leave it empty for a job that only runs when something asks it to — an unscheduled job is placed suspended."
        />
      ) : null}
      {/*
        The other half of "one App to many Components": an App is one scope, so
        a second Component builds the same image as its sibling, and the
        entrypoint is what makes it a different workload. Asked at creation
        rather than only after it, because a Component created to run
        differently that cannot say so exists as a duplicate of its sibling
        until somebody edits it.
      */}
      <Field
        name="component-entrypoint"
        label="Entrypoint"
        value={entrypoint}
        onChange={(event) => setEntrypoint(event.target.value)}
        placeholder="node job.js"
        hint="How this Component runs the image. Leave it empty for the image's own — a second Component off one image is usually this field and nothing else."
      />

      {outcome?.kind === 'refused' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === 'created' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          Created. Nothing is built and nothing is placed — select{' '}
          {outcome.name} and Deploy to build it and write its placement. It is
          private behind the proxy until Reach says otherwise.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving || name.trim() === ''}
          onClick={() => {
            void save();
          }}
        >
          {saving ? 'Adding…' : 'Add Component'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome?.kind === 'created' ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Changing how a Component is reached (§9).
 *
 * Reach and auth are one decision, so they are one form and one save — the same
 * shape the creation flow states them in, and literally the same tiles, so a
 * developer meets the grid once. `auth` disappears at `reach: none` there and
 * here, which is `AUTH_NEEDS_A_ROUTE` said by not asking rather than by
 * refusing after the press.
 *
 * **What it saves is a Component, not a release.** The chart renders the route,
 * the DNS annotations and the filter from values written at deploy time, so the
 * only honest thing this form can do when it succeeds is name the Targets whose
 * release still places the old answer and point at Deploy. Anything that read
 * as "done" would be a screen claiming an outcome the platform has not been
 * asked for yet.
 *
 * Exported because it is behind a disclosure: the sentence above is the whole
 * claim this form makes, and a test that could only reach the button would be
 * asserting that something opens rather than what it says when it does.
 */
export function ReachEditor({
  component,
  onSetReach,
  onDone,
}: {
  component: ComponentView;
  onSetReach: SetReach;
  onDone: () => void;
}) {
  const [reach, setReach] = useState(component.reach);
  const [auth, setAuth] = useState(component.auth);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'saved'; readonly pendingRelease: readonly string[] }
    | { readonly kind: 'refused'; readonly message: string }
    | null
  >(null);

  const save = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onSetReach({
        componentId: component.id,
        reach,
        // §9's grid: a Component with no route has nothing to authenticate in
        // front of, so `none` is not a choice being made for the operator — it
        // is the only cell that row has.
        auth: reach === 'none' ? 'none' : auth,
      });
      setOutcome(
        result.ok
          ? { kind: 'saved', pendingRelease: result.pendingRelease }
          : { kind: 'refused', message: result.message },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border-soft py-3 last:border-b-0">
      <div className="grid gap-2 sm:grid-cols-3">
        {REACHES.map((option) => (
          <Choice
            key={option}
            selected={reach === option}
            title={option}
            note={REACH_NOTE[option]}
            onClick={() => setReach(option)}
          />
        ))}
      </div>
      {reach !== 'none' ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {AUTHS.map((option) => (
            <Choice
              key={option}
              selected={auth === option}
              title={option}
              note={AUTH_NOTE[option]}
              onClick={() => setAuth(option)}
            />
          ))}
        </div>
      ) : null}

      {outcome?.kind === 'refused' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === 'saved' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          {outcome.pendingRelease.length === 0
            ? 'Saved. Nothing is placing the previous answer, so the next release carries this one.'
            : `Saved. ${outcome.pendingRelease.join(' and ')} still ${outcome.pendingRelease.length === 1 ? 'serves' : 'serve'} the previous answer — Deploy to place this one.`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            void save();
          }}
        >
          {saving ? 'Saving…' : 'Save reach'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome?.kind === 'saved' ? 'Close' : 'Cancel'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Reach is rendered into the release, so this takes effect on the next
          Deploy rather than on the one that is serving.
        </p>
      </div>
    </div>
  );
}

/**
 * Moving this Component to another Target, and retiring what it has left (§3,
 * §10).
 *
 * **The move is one post, never two.** `placeComponent` demands the keys that
 * will not follow *as part of the act* — its `supply` field exists so that
 * "demands them before the move commits" is true from the developer's side too
 * (`src/commands/components/place.ts:54-60`). So a refusal here opens a form
 * and the press that follows it is the same call again with `supply` filled
 * in. A `setConfig` pass followed by a retry would write those values at a
 * placement that does not exist yet, which is the shape core refuses.
 *
 * **The old pair keeps serving, and the screen says so.** A move writes the
 * new placement and leaves the row it moved away from alone, deliberately —
 * that is why every pair is listed here with its own Unplace. §13's rule is
 * "never destroy as a side effect of something else", and the move is
 * something else; retiring the old address is its own act, asked for by name.
 *
 * **What it does not do is a release.** Nothing is placed on the new Target
 * until Deploy runs, which is why the success sentence names Deploy and names
 * Rebuild: the artifact travels as it is where the new placement takes the
 * built shape (`takesShape`, which consults the adapter's whole accept list),
 * and where it does not,
 * `createDeploy` refuses with "this placement needs a rebuild" (§3) and
 * Rebuild in the header is the answer to it. Neither happens here — a form that
 * deployed as well would be substituting one act for the other, which
 * `deployApp`'s own header (`src/commands/apps/deploy.ts:1-43`) forbids.
 *
 * Exported for the reason {@link ReachEditor} is: it is behind a disclosure,
 * and `test/harness/dom.ts` cannot press the button that opens it.
 */
export function PlacementEditor({
  component,
  targets,
  onMoveComponent,
  onUnplaceComponent,
  onDone,
}: {
  component: ComponentView;
  targets: readonly TargetListItem[];
  onMoveComponent: MoveComponent;
  onUnplaceComponent: UnplaceComponent;
  onDone: () => void;
}) {
  const [chosen, setChosen] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | {
        readonly kind: 'moved';
        readonly to: string;
        readonly carried: readonly string[];
      }
    | {
        readonly kind: 'retired';
        readonly from: string;
        readonly destroyed: boolean;
      }
    | {
        readonly kind: 'refused';
        readonly message: string;
        readonly demanded: readonly string[];
      }
    | null
  >(null);

  /*
    The Targets that take this kind, and no others. `kinds` is the adapter's own
    answer (`KINDS_BY_ADAPTER`), so a `static` surface offered for a job would be
    a tile whose only outcome is a deploy that cannot be admitted — §3 lists a
    non-candidate with its reason where it is *choosing between* Targets, and
    this list is one Component's placement rather than that step.
  */
  const offered = targets.filter((target) =>
    target.kinds.includes(component.kind),
  );
  const serving = component.serving ?? [];
  const servingIds = new Set(serving.map((pair) => pair.targetId));

  const move = async (
    supply: readonly { key: string; value: string }[],
  ): Promise<void> => {
    if (chosen === null) return;
    const to = offered.find((target) => target.id === chosen) ?? null;
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onMoveComponent({
        componentId: component.id,
        targetId: chosen,
        supply,
      });
      setOutcome(
        result.ok
          ? {
              kind: 'moved',
              to: to === null ? 'the Target' : `${to.vessel}/${to.adapter}`,
              carried: result.carried,
            }
          : {
              kind: 'refused',
              message: result.message,
              demanded: result.demanded,
            },
      );
    } finally {
      setSaving(false);
    }
  };

  const retire = async (pair: { targetId: string; label: string }) => {
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onUnplaceComponent({
        componentId: component.id,
        targetId: pair.targetId,
      });
      setOutcome(
        result.ok
          ? { kind: 'retired', from: pair.label, destroyed: result.destroyed }
          : { kind: 'refused', message: result.message, demanded: [] },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border-soft py-3 last:border-b-0">
      <div className="flex flex-col gap-1.5">
        <Eyebrow>Still serving</Eyebrow>
        {/*
          One control per pair, because that is what the command takes. A move
          leaves two rows answering and `unplaceComponent` retires one of them
          by (Component, Target) — a single button could not say which, which is
          the reason the command has had no control at all until now.
        */}
        {serving.map((pair) => (
          <div key={pair.targetId} className="flex items-center gap-2 text-xs">
            <span className="font-mono">{pair.label}</span>
            <Button
              variant="outline"
              size="sm"
              className="ml-auto"
              disabled={saving}
              onClick={() => {
                void retire(pair);
              }}
            >
              Unplace
            </Button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Eyebrow>Move to</Eyebrow>
        {offered.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No connected Target takes a {component.kind}.
          </p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {offered.map((target) => (
              <Choice
                key={target.id}
                selected={chosen === target.id}
                title={`${target.vessel}/${target.adapter}`}
                note={
                  servingIds.has(target.id)
                    ? 'already serving this Component'
                    : `rank ${target.rank} · ${target.health}`
                }
                onClick={() => setChosen(target.id)}
              />
            ))}
          </div>
        )}
      </div>

      {outcome?.kind === 'refused' ? (
        outcome.demanded.length === 0 ? (
          <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {outcome.message}
          </p>
        ) : (
          <SupplyDemand
            message={outcome.message}
            demanded={outcome.demanded}
            busy={saving}
            onSupply={(supply) => {
              void move(supply);
            }}
          />
        )
      ) : null}
      {outcome?.kind === 'moved' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          Moved to {outcome.to}. Nothing is running there yet — Deploy places
          the artifact that is already built, and where the new Target cannot
          take that Build&apos;s shape Deploy says so and Rebuild is the answer.
          {outcome.carried.length === 0
            ? ''
            : ` ${outcome.carried.join(', ')} came with it as references; no value was read.`}{' '}
          Whatever was serving before is still serving until it is unplaced.
        </p>
      ) : null}
      {outcome?.kind === 'retired' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          {outcome.destroyed
            ? `Torn down on ${outcome.from}. That address answers nothing now.`
            : `Retired ${outcome.from}. Nothing was running there to tear down.`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving || chosen === null}
          onClick={() => {
            void move([]);
          }}
        >
          {saving ? 'Moving…' : 'Move'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome === null || outcome.kind === 'refused' ? 'Cancel' : 'Close'}
        </Button>
      </div>
    </div>
  );
}

/**
 * The keys that will not follow, as a form rather than as a dead end (§10).
 *
 * §10's carve-out is the boundary: "core never retrieves, therefore core cannot
 * migrate config between stores", so a move to a Target behind a different
 * store of record cannot carry the values and `placeComponent` refuses naming
 * them. That refusal is not an error to be stuck behind — it is a question, and
 * the only screen that can answer it is the one the operator is on.
 *
 * The sentence above the fields is core's own, unedited, because it says what
 * the fields cannot: which store cannot be reached, and that no value is being
 * read back to be shown here.
 *
 * Its own component, and exported, so that the refusal state is renderable
 * without pressing anything — the DOM shim cannot press, and this is the arm of
 * the move that most needs asserting.
 */
export function SupplyDemand({
  message,
  demanded,
  busy,
  onSupply,
}: {
  message: string;
  demanded: readonly string[];
  busy?: boolean;
  onSupply: (supply: readonly { key: string; value: string }[]) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="flex flex-col gap-3 rounded-md border border-warning/40 bg-warning-soft px-3 py-3">
      <p className="text-xs">{message}</p>
      {demanded.map((key) => (
        <Field
          key={key}
          name={`supply-${key}`}
          label={key}
          value={values[key] ?? ''}
          onChange={(event) =>
            setValues((current) => ({ ...current, [key]: event.target.value }))
          }
          type="password"
          hint="Written through the ordinary config path — pinned, audited, and never read back."
        />
      ))}
      <div>
        <Button
          size="sm"
          disabled={busy || demanded.some((key) => (values[key] ?? '') === '')}
          onClick={() =>
            onSupply(demanded.map((key) => ({ key, value: values[key] ?? '' })))
          }
        >
          {busy ? 'Moving…' : 'Supply and move'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Where this App is built from (§5, §15) — the repository, the scope inside it,
 * and the `spindrift.yaml` that governs the build.
 *
 * **It reads its own row.** `getAppSource` asks the repository host for one
 * file, and the workspace re-reads itself every two seconds while a release is
 * in flight; folding this into that read would spend a rate limit on an answer
 * nobody asked for again. `null` cadence — once per visit to this tab, the same
 * trade `Releases` makes for its rows.
 *
 * **A failed read takes nothing off the screen.** The card is rendered on what
 * came back and nothing else: an App with no source (an uploaded archive) and
 * a read still in flight both render nothing, and a repository host that would
 * not answer renders the two facts Spindrift holds itself with the reason
 * beside the third.
 */
function SourceSection({ app }: { app: string }) {
  const read = useRead([['getAppSource', { app }]], null, [app]);
  const source = read.type === 'success' ? read.value[0].source : null;
  if (source === null) return null;

  const { manifest } = source;
  // The file at the commit that is governing, never at the branch tip: it is
  // the revision `getAppSource` read, and a link to `main` would open a
  // different document the day after somebody pushes.
  const manifestUrl =
    source.url === null || source.commit === null
      ? null
      : `${source.url}/blob/${source.commit}/${manifest.path}`;

  return (
    <Card>
      <SectionHeader eyebrow="Where this App is built from" title="Source" />
      <CardContent className="pt-0">
        <Row
          badge={<Badge tone="idle">repo</Badge>}
          title={source.repo}
          detail={
            source.branch === null
              ? 'no repository connected — §15 integration is off for this App'
              : `${source.branch}${source.commit === null ? ', nothing adopted yet' : ` at ${source.commit.slice(0, 7)}`}`
          }
          trailing={
            source.url === null ? undefined : (
              <Button variant="outline" size="sm" asChild>
                <a
                  href={normaliseUrl(source.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open
                </a>
              </Button>
            )
          }
        />
        <Row
          badge={<Badge tone="idle">folder</Badge>}
          title={
            source.subpath === '.' ? '. (repository root)' : source.subpath
          }
          detail="the one directory this App is built from (§5)"
        />
        <Row
          badge={
            /*
              Three words for three states, because two of them would make the
              unread one a claim. A file that is there means this App is
              declared; a scope without one means detection decides; a read that
              could not happen means neither is known, and saying "detected"
              there would be this screen guessing on somebody's behalf.
            */
            <Badge tone={manifest.state === 'present' ? 'accent' : 'idle'}>
              {manifest.state === 'present'
                ? 'declared'
                : manifest.state === 'absent'
                  ? 'detected'
                  : 'unknown'}
            </Badge>
          }
          title={manifest.path}
          detail={
            manifest.state === 'present'
              ? 'on the default branch, so it wins over detection'
              : manifest.state === 'absent'
                ? 'not in this scope — detection decides how this builds'
                : manifest.because
          }
          trailing={
            manifest.state === 'present' && manifestUrl !== null ? (
              <Button variant="outline" size="sm" asChild>
                <a href={manifestUrl} target="_blank" rel="noreferrer noopener">
                  Open
                </a>
              </Button>
            ) : undefined
          }
        />
        {manifest.state === 'present' ? (
          <div className="pt-2">
            <Declaration
              title="What it says"
              label={manifest.path}
              text={manifest.text}
              note="The adopted file itself, as Spindrift read it. Editing it is a pull request against the repository — nothing here writes to it."
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The selected Component's environment configuration (§10).
 *
 * Keys only, ever — the same posture core's config commands take, kept all
 * the way to the screen: nothing here has ever been handed a value, so there
 * is nothing here that could show one by accident.
 * "Set variable" is the one form underneath, because `setConfig` upserts —
 * naming a key that already exists overwrites it, so add and edit are one
 * act, not two the operator has to choose between.
 *
 * The Component is named above the list because config is scoped to one
 * (Component, Target) pair and this App may have several: a heading that said
 * only "Config" was the same list claiming to be the App's.
 */
/**
 * The App's own address (§9).
 *
 * §9's naming is two layers and only one of them is a decision. The canonical
 * always resolves and nobody picks it — on a Target that names its own
 * workloads it *is* the platform's name. The vanity is the name a developer
 * shares, and until this section existed there was nowhere in the product to
 * choose one: `setAppVanity` and `setAppZone` were registered commands with no
 * hand reaching them.
 *
 * **Three tiles, and the apex is one of them.** The stored value is one DNS
 * label or the literal `@`, and a text field that silently accepts `@` is a
 * puzzle rather than a control — the one non-label choice is the one people
 * most want, so it is a thing to press. `@` never appears on screen; it is only
 * what this sends.
 *
 * **Two writes, zone first.** The zone is a separate column and a separate
 * command, and it is the one that can be refused — a zone that cannot serve a
 * placed Component's reach is not a pin `setAppZone` will take. Landing the
 * label into a zone that is about to be refused would leave two half-applied
 * facts, so the label only goes after the zone lands.
 *
 * **Nothing here changes what is serving.** The name is attached to the Target
 * and the record is published during a deploy, so setting it is a statement
 * about the next one. Said, rather than left to be discovered.
 */
function DomainSection({
  domain,
  onSetDomain,
}: {
  domain: AppDomainView;
  onSetDomain?: SetDomain;
}) {
  const [choice, setChoice] = useState<'none' | 'apex' | 'label'>(
    domain.label === null ? 'none' : domain.label === '@' ? 'apex' : 'label',
  );
  const [label, setLabel] = useState(
    domain.label === null || domain.label === '@' ? '' : domain.label,
  );
  const [zone, setZone] = useState(domain.zone ?? domain.zones[0]?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const issue =
    choice === 'label' && label !== '' && !isLabel(label)
      ? 'One lowercase label: letters, numbers and hyphens.'
      : null;
  const preview =
    choice === 'none'
      ? null
      : choice === 'apex'
        ? zone
        : label === ''
          ? null
          : `${label}.${zone}`;

  const save = async () => {
    if (onSetDomain === undefined || issue !== null) return;
    setSaving(true);
    setFailure(null);
    const result = await onSetDomain({
      zone: zone === '' ? null : zone,
      label: choice === 'none' ? null : choice === 'apex' ? '@' : label,
    });
    setSaving(false);
    if (!result.ok) setFailure(result.message);
  };

  return (
    <Card>
      <SectionHeader eyebrow="App address" title="Domain" />
      <CardContent className="flex flex-col gap-4">
        {/*
          Stated before the control, because it is the difference between a
          name that will be published and one that will not. §9 puts the
          shared name on the App and the reconciler refuses to guess which of
          two serving Components it means — so this is not advice, it is what
          is happening.
        */}
        {domain.ambiguous ? (
          <p className="rounded-md border border-destructive bg-destructive-soft px-3 py-2.5 text-sm text-destructive">
            Nothing is published under a name of your own. More than one
            Component serves, and Spindrift will not choose which one the name
            means. Leave one serving, or the name stays unused.
          </p>
        ) : null}

        <div className="grid gap-2 sm:grid-cols-3">
          <Choice
            selected={choice === 'none'}
            title="No name of your own"
            note="Only the address the Target mints."
            onClick={() => setChoice('none')}
          />
          {/*
            The one tile that carries a warning, because it is the one choice
            that is not fully reversible from here. A record at a zone apex is
            published once and never re-pointed or withdrawn — see `isApexName`
            for why — so choosing it commits the bare domain to this App until
            somebody edits DNS by hand.
          */}
          <Choice
            selected={choice === 'apex'}
            title="The domain itself"
            note={
              zone === ''
                ? 'The bare domain. Published once — moving it later is a hand edit in DNS.'
                : `${zone} — published once. Moving it later is a hand edit in DNS.`
            }
            onClick={() => setChoice('apex')}
          />
          <Choice
            selected={choice === 'label'}
            title="A name under it"
            note={
              zone === '' ? 'One label under the domain.' : `something.${zone}`
            }
            onClick={() => setChoice('label')}
          />
        </div>

        {choice === 'label' ? (
          <Field
            name="vanityLabel"
            label="Name"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            issue={issue}
            hint="One lowercase label. Letters, numbers and hyphens."
          />
        ) : null}

        {/*
          Offered only where there is a choice to make. One zone is not a
          question, and a select with one option is a control that teaches
          somebody the word "zone" for nothing.
        */}
        {domain.zones.length > 1 && choice !== 'none' ? (
          <Field
            name="zone"
            label="Which domain"
            hint="Domains your admin configured, in Settings."
          >
            <select
              id="zone"
              value={zone}
              onChange={(event) => setZone(event.target.value)}
              className="w-full rounded-md border border-border bg-card px-3 py-2 font-mono text-sm"
            >
              {domain.zones.map((option) => (
                <option key={option.name} value={option.name}>
                  {option.name} — reachable from {option.reaches.join(' and ')}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        {failure ? <p className="text-sm text-destructive">{failure}</p> : null}

        <div className="flex flex-wrap items-center gap-3">
          <Button
            disabled={onSetDomain === undefined || saving || issue !== null}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save domain'}
          </Button>
          <p className="text-xs text-muted-foreground">
            {/*
              The record is published by a deploy, not by this button —
              the name is attached during apply and the DNS write happens in the
              deploy loop. A control that let somebody walk away believing the
              name was live would be the screen lying by omission.

              And it promises nothing while more than one Component serves: the
              banner above says that name will not be published, so a sentence
              here saying the App answers on it is the same screen arguing with
              itself two inches apart.
            */}
            {preview === null
              ? 'This App answers on the address its Target mints.'
              : domain.ambiguous
                ? `Saved as ${preview}, and not published while more than one Component serves.`
                : choice === 'apex'
                  ? `This App answers on ${preview} after its next deploy. A bare domain is published once — if it already points somewhere, change it in your DNS provider.`
                  : `This App answers on ${preview} after its next deploy.`}
          </p>
        </div>

        {domain.hostnames.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Publishing now:{' '}
            <span className="font-mono">{domain.hostnames.join(', ')}</span>
          </p>
        ) : null}

        {/*
          Said where the name is chosen rather than where it is lost. An App has
          one Component when it is created and grows a second later, so the
          person who set this name is not the person who will be looking at the
          Components list when it stops being published.
        */}
        {!domain.ambiguous && domain.servedBy !== null && choice !== 'none' ? (
          <p className="text-xs text-muted-foreground">
            Carried by {domain.servedBy}, while it is the only Component this
            App serves. Add a second serving Component and this name stops being
            published.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ConfigSection({
  configKeys,
  component,
  onSetConfig,
}: {
  configKeys: readonly string[];
  /** Whose keys these are. Absent for an App with no Components yet. */
  component?: string;
  onSetConfig?: SetConfig;
}) {
  const [adding, setAdding] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  return (
    <Card>
      <SectionHeader
        eyebrow={
          component === undefined
            ? 'App configuration'
            : `Configuration for ${component}`
        }
        title="Config"
        {...(onSetConfig
          ? {
              action: adding ? 'Close' : 'Set variable',
              onAction: () => setAdding((current) => !current),
            }
          : {})}
      />
      <CardContent className="pt-0">
        {onSetConfig && adding ? (
          <ConfigVarForm
            onSetConfig={onSetConfig}
            onDone={() => setAdding(false)}
          />
        ) : null}
        {deleteError ? (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {deleteError}
          </p>
        ) : null}
        {configKeys.length === 0 ? (
          <EmptyState title="No configuration is set.">
            Values are write-only — Spindrift stores one secret per variable and
            never reads one back, including here.
          </EmptyState>
        ) : (
          configKeys.map((key) => (
            <Row
              key={key}
              badge={<Badge tone="idle">env</Badge>}
              title={key}
              detail="value is write-only"
              trailing={
                onSetConfig ? (
                  <DeleteConfigVarButton
                    configKey={key}
                    onSetConfig={onSetConfig}
                    onError={setDeleteError}
                  />
                ) : undefined
              }
            />
          ))
        )}
        <p className="pt-2 text-xs text-muted-foreground">
          A config change redeploys what is running under a new configVersion —
          or says why nothing was redeployed, the same way Deploy does.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Setting one variable — write-only in, so the value field always starts
 * blank, even for a key that already has one (§10: nothing above the store
 * has ever been allowed to read it back).
 */
function ConfigVarForm({
  onSetConfig,
  onDone,
}: {
  onSetConfig: SetConfig;
  onDone: () => void;
}) {
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'saved'; readonly notDeployed: string | null }
    | { readonly kind: 'refused'; readonly message: string }
    | null
  >(null);

  const save = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onSetConfig({
        entries: [{ key: key.trim(), value }],
        removals: [],
      });
      if (result.ok) {
        setOutcome({ kind: 'saved', notDeployed: result.notDeployed });
        setKey('');
        setValue('');
      } else {
        setOutcome({ kind: 'refused', message: result.message });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 border-b border-border-soft pb-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <Field
          name="config-key"
          label="Key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          placeholder="DATABASE_URL"
        />
        <Field
          name="config-value"
          label="Value"
          type="password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="written once, never shown again"
        />
      </div>
      {outcome?.kind === 'refused' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === 'saved' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          {outcome.notDeployed ??
            'Saved. Redeployed under the new configuration.'}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={saving || key.trim() === ''}
          onClick={() => {
            void save();
          }}
        >
          {saving ? 'Saving…' : 'Save variable'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome?.kind === 'saved' ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Removing one variable, and nothing else.
 *
 * `setConfig` takes the key alone — unlike `replaceConfig`'s upload, a
 * removal never asks this button to restate the values of the keys it is
 * leaving alone, which is the whole reason deleting one key does not mean
 * retyping every other one. No local confirmation state: the button has
 * nowhere on the row to show one, so a refusal is reported to the section
 * above instead of being lost.
 *
 * Exported for `test/web/views.test.tsx`, which calls it directly to prove
 * what pressing it sends — the same reason `DeleteAppButton` is.
 */
export function DeleteConfigVarButton({
  configKey,
  onSetConfig,
  onError,
}: {
  configKey: string;
  onSetConfig: SetConfig;
  onError: (message: string | null) => void;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => {
        onError(null);
        void onSetConfig({ entries: [], removals: [configKey] }).then(
          (result) => {
            if (!result.ok) onError(result.message);
          },
        );
      }}
    >
      Delete
    </Button>
  );
}

const MARKER_TONE = {
  ok: 'border-success bg-success',
  failed: 'border-destructive bg-destructive',
  info: 'border-border bg-card',
} as const satisfies Record<ActivityEntry['status'], string>;

/**
 * The timeline, and a way in from every line of it.
 *
 * A **timeline, not a list** — the rows are joined by a rule the markers sit
 * on, because these entries are one sequence and stacked cards said they were
 * unrelated events that happened to be near each other. The connector is what
 * carries the reading down the column, and the newest checkpoint is at the top
 * where the last thing that happened belongs.
 *
 * The stage each row belongs to is on the row, and it is load-bearing rather
 * than decorative: **Build and Deploy are separate stages**, so a column of red
 * has to say which of the two went red. `attempt_events` constrains every row
 * to exactly one attempt, so the lane is always knowable and every entry has
 * somewhere to go — `/deploys/:id` or `/builds/:id`. An entry that led nowhere
 * would be the one thing on this screen a reader could not act on.
 */
function Activity({
  entries,
  onNavigate,
}: {
  entries: readonly ActivityEntry[];
  onNavigate?: (path: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <div>
          <Eyebrow>Recent checkpoints</Eyebrow>
          <h2 className="text-base font-semibold tracking-tight">
            What happened
          </h2>
        </div>
        {onNavigate ? (
          <div className="ml-auto flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate('/builds')}
            >
              Browse Builds
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onNavigate('/deploys')}
            >
              Browse Deploys
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="pt-0">
        {entries.length === 0 ? (
          <EmptyState title="Nothing has happened yet.">
            Build and deploy checkpoints land here as they arrive.
          </EmptyState>
        ) : (
          <ol className="relative flex flex-col">
            {/*
              One rule behind every marker, stopped short at both ends so the
              sequence reads as bounded rather than continuing off the card
              into checkpoints that are not shown.
            */}
            <span
              aria-hidden="true"
              className="absolute left-[5px] top-3 bottom-3 w-px bg-border-soft"
            />
            {/*
              Keyed by position rather than by content. Every part of the old
              key was displayed text, so two checkpoints that read alike — the
              ordinary case for one attempt reported twice a minute apart —
              collided. This list is server-derived, newest-first, read-only and
              holds no per-row state, so position is a stable identity for it.
            */}
            {entries.map((entry, index) => (
              <ActivityRow key={index} entry={entry} onNavigate={onNavigate} />
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  entry,
  onNavigate,
}: {
  entry: ActivityEntry;
  onNavigate?: (path: string) => void;
}) {
  const path =
    entry.deployId !== null
      ? `/deploys/${entry.deployId}`
      : entry.buildId !== null
        ? `/builds/${entry.buildId}`
        : null;

  const body = (
    <>
      {/*
        The marker sits on the rule rather than beside it — `bg-card` on an
        `info` dot is what punches it through the line, so a checkpoint reads
        as a point on the sequence instead of a bullet next to one.
      */}
      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 mt-[7px] size-[11px] shrink-0 rounded-full border-2',
          MARKER_TONE[entry.status],
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Badge tone={entry.kind === 'deploy' ? 'accent' : 'idle'}>
            {entry.kind}
          </Badge>
          <p className="truncate text-sm font-medium">{entry.title}</p>
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground">
            {entry.when}
          </span>
        </div>
        {entry.detail ? (
          <p className="truncate text-xs text-muted-foreground">
            {entry.detail}
          </p>
        ) : null}
      </div>
    </>
  );

  const shape = 'flex w-full items-start gap-2.5 py-2 text-left';

  return (
    <li className="relative">
      {path === null || !onNavigate ? (
        <div className={shape}>{body}</div>
      ) : (
        <button
          type="button"
          onClick={() => onNavigate(path)}
          className={cn(shape, 'rounded-md hover:bg-secondary/50')}
        >
          {body}
        </button>
      )}
    </li>
  );
}

/**
 * A Component's output surface — one of §17's three, kept honestly distinct.
 *
 * §17 draws two lines this branch exists to hold. **A job is not a stream but a
 * list of executions**: an execution terminates, so it is attempt-shaped, and
 * the tail pipe covers services only. And a **`static` Target gets an honest
 * empty state** rather than a disabled tab, because there is no process to
 * follow rather than a stream that happens to be quiet.
 *
 * For the one case that *is* a stream, the view **follows the Component**:
 * Deploys are markers on it, never a filter, which is the only shape that lets
 * a human read across a rollback boundary. Its reach is stated — §17 makes
 * `logHistory` a duration rather than a capability, so a Target never lacks
 * logs, it only has a shorter memory, and saying how short is the whole point.
 */
function Runtime({
  view,
  component,
  onNavigate,
  onRun,
  onFollowExecution,
  executionLines,
}: {
  view: WorkspaceView;
  /**
   * Whose output this is. An App has as many runtimes as it has Components and
   * this card shows one of them, so the card says which — "Recent runs" over an
   * App with a service and two jobs names none of them.
   */
  component?: string;
  onNavigate?: (path: string) => void;
  /**
   * Start one run (§17). Absent where the screen has no act wired — the
   * fixture renders, and any Component that is not a placed job.
   */
  onRun?: RunJob;
  /**
   * Follow one run's output, or nothing when the name is `null`.
   *
   * The lines come back as {@link executionLines} rather than through this
   * callback, because the socket outlives any one render and the screen above
   * owns it — the same split the service tail already has.
   */
  onFollowExecution?: (execution: string | null) => void;
  executionLines?: readonly LogLine[];
}) {
  const runtime = view.runtime;
  const latestDeployId = view.latestDeployId;
  /** Which run's output is open. One at a time: this is a list, not a tree. */
  const [following, setFollowing] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  /**
   * This run's parameters, as typed (§17's one-off script with an argument).
   * A row with no name is a row the operator has not filled in, not a variable
   * called nothing, so it is left out rather than refused.
   */
  const [parameters, setParameters] = useState<
    readonly { id: string; key: string; value: string }[]
  >([]);

  const follow = (execution: string) => {
    const next = following === execution ? null : execution;
    setFollowing(next);
    onFollowExecution?.(next);
  };

  const start = async () => {
    if (!onRun) return;
    setStarting(true);
    setRunError(null);
    const env = Object.fromEntries(
      parameters
        .filter((parameter) => parameter.key.trim() !== '')
        .map((parameter) => [parameter.key.trim(), parameter.value]),
    );
    const result = await onRun(Object.keys(env).length === 0 ? undefined : env);
    setStarting(false);
    if (!result.ok) setRunError(result.message);
    else setParameters([]);
  };

  const editParameter = (
    id: string,
    change: Partial<{ key: string; value: string }>,
  ) =>
    setParameters((current) =>
      current.map((parameter) =>
        parameter.id === id ? { ...parameter, ...change } : parameter,
      ),
    );

  return (
    <Card>
      <SectionHeader
        eyebrow={
          component === undefined
            ? 'Component output'
            : `Output of ${component}`
        }
        title={TITLE[runtime.kind]}
        action={ACTION[runtime.kind]}
        onAction={
          latestDeployId && onNavigate
            ? () => onNavigate(`/deploys/${latestDeployId}`)
            : undefined
        }
      />
      <CardContent className="pt-0">
        {runtime.kind === 'none' ? (
          <EmptyState title="No runtime exists for this Component.">
            {runtime.because}
          </EmptyState>
        ) : runtime.kind === 'executions' ? (
          <>
            {/*
              §17's other half of `apply` for a job: the chart renders a
              CronJob that is triggered by nothing, so an unscheduled job is
              only ever run because somebody asked. The button is what asking
              is, and it sits with the runs rather than beside Deploy because
              running is not deploying — nothing about what is placed changes.
            */}
            {onRun ? (
              <div className="flex flex-col gap-2 pb-2">
                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={starting}
                    onClick={() => void start()}
                  >
                    {starting ? 'Starting...' : 'Run now'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={starting}
                    onClick={() =>
                      setParameters((current) => [
                        ...current,
                        { id: crypto.randomUUID(), key: '', value: '' },
                      ])
                    }
                  >
                    Add parameter
                  </Button>
                  {runError ? (
                    <p className="text-xs text-destructive">{runError}</p>
                  ) : null}
                </div>
                {/*
                  `ConfigVarForm`'s grid, minus the password field: a parameter
                  is an argument to one run, not a secret — a secret goes
                  through config, and a name config already delivers is what
                  `runComponent` refuses.
                */}
                {parameters.map((parameter) => (
                  <div
                    key={parameter.id}
                    className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]"
                  >
                    <Field
                      name={`run-parameter-${parameter.id}-key`}
                      label="Name"
                      value={parameter.key}
                      onChange={(event) =>
                        editParameter(parameter.id, { key: event.target.value })
                      }
                      placeholder="SNAPSHOT"
                    />
                    <Field
                      name={`run-parameter-${parameter.id}-value`}
                      label="Value"
                      value={parameter.value}
                      onChange={(event) =>
                        editParameter(parameter.id, {
                          value: event.target.value,
                        })
                      }
                      placeholder="for this run only"
                    />
                    <Button
                      variant="ghost"
                      size="sm"
                      className="self-end"
                      disabled={starting}
                      onClick={() =>
                        setParameters((current) =>
                          current.filter((row) => row.id !== parameter.id),
                        )
                      }
                    >
                      Remove
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {/*
              A read that failed keeps this arm so the button above stays
              pressable, and says why here. Rendering the empty-list sentence
              instead would claim the job has never run when what happened is
              that nobody could find out.
            */}
            {runtime.because ? (
              <EmptyState title="These runs could not be read.">
                {runtime.because}
              </EmptyState>
            ) : runtime.executions.length === 0 ? (
              <EmptyState title="This job has not run yet.">
                A run started here, or by the schedule, appears in this list.
              </EmptyState>
            ) : null}
            {runtime.executions.map((execution) => (
              <div key={execution.name}>
                {/*
                  A run's logs are read by naming the run, so the row is what
                  names it. Pressing it again closes the pane rather than
                  leaving the screen holding a socket nobody is reading.
                */}
                <button
                  type="button"
                  className="w-full text-left"
                  onClick={
                    onFollowExecution ? () => follow(execution.name) : undefined
                  }
                >
                  <Row
                    badge={
                      <Badge tone={EXECUTION_TONE[execution.outcome]}>
                        {execution.outcome}
                      </Badge>
                    }
                    title={execution.name}
                    detail={`${execution.detail} · ${execution.when}`}
                  />
                </button>
                {following === execution.name ? (
                  <FollowedLog lines={executionLines ?? []} />
                ) : null}
              </div>
            ))}
            {/*
              What this number is, and nothing more. It is the page size the
              screen asks for, which on `kubernetes` also happens to be the
              chart's `successfulJobsHistoryLimit` and on `cloudrun` is not the
              retention of anything — saying "the last N are kept" there sends
              an operator looking for a run that `gcloud` still has.

              Not shown at all on a failed read: nothing was shown, so a caption
              claiming ten of anything is the empty-list lie the sentence above
              it exists to avoid.
            */}
            {runtime.because ? null : (
              <p className="pt-2 text-xs text-muted-foreground">
                Showing the last {runtime.retained} runs. The history lives on
                the Target, not here.
              </p>
            )}
          </>
        ) : (
          <>
            <FollowedLog lines={runtime.lines} />
            <p className="pt-2 text-xs text-muted-foreground">
              This Target keeps {runtime.reach} of history. Deploys are markers
              on this stream, never a filter.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * How many lines of a live tail the page holds.
 *
 * `app.tsx` appends every socket page to `runtime.lines` and never drops one,
 * so a chatty service grew this array — and the DOM under it — for as long as
 * the workspace stayed open. The cap is a window on the end of the stream,
 * which is what a tail is; the history behind it lives on the Target, and this
 * card already says how far back that reaches.
 */
const TAIL_LINES = 2_000;

/**
 * The live tail: following, capped, and honest about the cap.
 *
 * Both `LogPane` mounts on this screen omitted `follow`, which is the flag that
 * makes the pane auto-scroll *and* the flag that gives it a maximum height — so
 * the one genuinely streaming surface in the product never showed its newest
 * line and pushed the whole page down instead of scrolling inside itself. The
 * two are one flag on purpose: a pane with no bottom has nothing to follow to.
 *
 * The "showing the last N" line is the same admission `Transcript` makes on the
 * build log. A pane that silently drops the beginning of a stream is a pane
 * that has answered "the error is not in the logs" for somebody.
 */
function FollowedLog({ lines }: { lines: readonly LogLine[] }) {
  const dropped = Math.max(0, lines.length - TAIL_LINES);
  return (
    <>
      <LogPane lines={dropped === 0 ? lines : lines.slice(dropped)} follow />
      {dropped === 0 ? null : (
        <p className="pt-1.5 text-xs text-muted-foreground">
          Showing the last {TAIL_LINES} lines — {dropped} older{' '}
          {dropped === 1 ? 'line has' : 'lines have'} scrolled out of this pane.
        </p>
      )}
    </>
  );
}

const TITLE = {
  stream: 'Runtime',
  executions: 'Recent runs',
  none: 'Runtime',
} as const satisfies Record<WorkspaceView['runtime']['kind'], string>;

const ACTION = {
  stream: 'Open logs',
  executions: 'All executions',
  none: 'Build activity',
} as const satisfies Record<WorkspaceView['runtime']['kind'], string>;

const EXECUTION_TONE = {
  passed: 'success',
  failed: 'destructive',
  running: 'warning',
} as const;

/**
 * A refreshed workspace, keeping what the socket knows and the read does not.
 *
 * Two things, for one reason: `getAppWorkspace` never asks the adapter. It
 * answers `stream` for any placed Component and hands back an empty first page,
 * because tailing at read time is the socket's whole job — so on both counts
 * the read is the weaker source about the same pair, and taking `runtime`
 * wholesale lets it win every tick.
 *
 * The lines are the obvious half: every line after the first arrived over the
 * socket and lives in this screen's state, so a refresh that took `runtime`
 * whole would wipe the log every few seconds.
 *
 * A `none` is the other. It is the answer for a Component that is placed and
 * not running — no pods, a Target that runs nothing — and it can only come from
 * the socket, so a refresh used to put `stream` back and the effect resubscribe
 * to be told `none` again. The card swapped its title and its body, from the
 * reason to an empty log and back, for as long as the screen was open.
 *
 * Both are kept only where the two reads are about the same Component on the
 * same Target. The selection can move while a refresh is in flight, and a
 * Component's output rendered under another Component's name is a worse answer
 * than the empty card the next socket page fills. A `none` is held to more than
 * that — the release has to be the same one, in the same phase — because it is
 * a claim about what is running, and a Deploy is what changes that.
 *
 * ponytail: a runtime that recovers without moving either — pods coming back on
 * a release that stayed LIVE — keeps saying `none` until the selection changes
 * or the page is re-opened. Closing that means the pane subscribing on the
 * Component and Target it is about rather than on the read's own answer to the
 * question the socket exists to answer, and the server holding the socket open
 * through a `none` instead of closing it.
 *
 * Exported for `test/web/workspace-refresh.test.ts`: this is where the
 * selection and the socket meet, and reaching it through the mounted screen
 * means pressing a row, which the DOM shim does not simulate.
 */
export function refreshedWorkspace(
  current: WorkspaceView,
  fresh: WorkspaceView,
): WorkspaceView {
  const sameSubject =
    current.componentId === fresh.componentId &&
    current.targetId === fresh.targetId;
  if (
    sameSubject &&
    current.runtime.kind === 'none' &&
    fresh.runtime.kind === 'stream' &&
    current.latestDeployId === fresh.latestDeployId &&
    current.phase === fresh.phase
  ) {
    return { ...fresh, runtime: current.runtime };
  }
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
 * One typed entrypoint, as an argv.
 *
 * ponytail: splits on whitespace and nothing else, so `sh -c "a b"` arrives as
 * four words rather than three. The case this field exists for is `node
 * job.js` — a monolith's second Component naming its own entrypoint — and a
 * shell-quoting parser here would be a second, worse `shlex` in front of a
 * command that stores whatever list it is given. Give it a real argv editor the
 * day somebody needs a quoted argument.
 *
 * Exported for `test/web/component-create.test.ts`, which is where the split is
 * pinned: the schema refuses an empty string inside the list, so a form that
 * produced one would be refused after the press rather than before it.
 */
export function argvOf(entrypoint: string): string[] {
  return entrypoint.trim().split(/\s+/);
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
 * because `InputOf` reads a command's schema *output* — the same reason the
 * Datastore ledger's `handleCreate` restates `storageGiB`, and the same care:
 * no form offers any of the three, so this is the one place they are named, and
 * naming them here is what keeps the form from having a second opinion.
 *
 * Exported for `test/web/component-create.test.ts`, for the reason
 * {@link refreshedWorkspace} is: what is under test is which fields a kind
 * sends, and reaching it through the mounted screen means pressing a tile,
 * which the DOM shim does not simulate.
 */
export function componentCreation(
  appId: string,
  create: {
    name: string;
    kind: ComponentKind;
    schedule?: string;
    command?: string[];
  },
): InputOf<'createComponent'> {
  const common = {
    appId,
    name: create.name,
    reach: 'private',
    auth: 'proxy',
    // Absent rather than null for the image's own entrypoint, the same way an
    // unscheduled job omits `schedule`: the command reads both as "nothing was
    // said", and only one of the two spellings survives a `.strict()` union
    // gaining a field this form does not offer.
    ...(create.command === undefined ? {} : { command: create.command }),
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
/**
 * The workspace screen (§18) — one App, the Component of it being looked at,
 * and everything an operator can do to either.
 *
 * `appName` empty is its own answer rather than a read: `/apps/` names no App,
 * and asking the server about the empty name would be a round trip to be told
 * what the path already says. It is split off around the read so the read's
 * hooks are unconditional.
 */
export function WorkspaceScreen({
  appName,
  onNavigate,
}: {
  appName: string;
  onNavigate: (path: string) => void;
}) {
  if (!appName) {
    return (
      <ScreenNotFound
        title={'No App named ""'}
        message="No App name provided"
        onNavigate={onNavigate}
      />
    );
  }
  return <AppWorkspace appName={appName} onNavigate={onNavigate} />;
}

function AppWorkspace({
  appName,
  onNavigate,
}: {
  appName: string;
  onNavigate: (path: string) => void;
}) {
  const [deploying, setDeploying] = useState(false);
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

  // There is no workspace left to stand on once the App is gone.
  const deletion = useAppDeletion(() => onNavigate('/apps'));

  /**
   * The Targets a move can name (§3).
   *
   * Read once beside the workspace rather than folded into it: `getAppWorkspace`
   * answers about one App, and the installation's Targets are not one App's
   * fact — the Targets screen reads the same list. A failure is left where it
   * lands and never rendered, and the consequence is stated where it shows: the
   * Move control is not offered over a list this screen has not got, rather
   * than offered over an empty one.
   */
  const targetList = useRead([['listTargets', {}]], null);
  const targets =
    targetList.type === 'success' ? targetList.value[0].targets : [];

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
   *
   * The selection is named on every read, or it would put the App's first
   * Component back on screen every few seconds — and it is in `deps`, so a
   * response still in flight when the selection moves is dropped rather than
   * put on screen under a Component this screen has left.
   */
  const read = useRead(
    [
      [
        'getAppWorkspace',
        { name: appName, ...(component === null ? {} : { component }) },
      ],
    ],
    (current) =>
      current !== null && isInFlight(current[0].workspace.phase)
        ? 2_000
        : 20_000,
    [appName, component],
    ([fresh], [current]) => [
      {
        ...fresh,
        workspace: refreshedWorkspace(current.workspace, fresh.workspace),
      },
    ],
  );

  const view = read.type === 'success' ? read.value[0].workspace : null;
  const runtime = view?.runtime.kind === 'stream' ? view.runtime : null;
  useEffect(() => {
    if (runtime === null) return;
    return subscribeRuntime(
      {
        componentId: runtime.componentId,
        targetId: runtime.targetId,
      },
      (page) => {
        read.update((current) => {
          const [{ workspace }] = current;
          if (workspace.runtime.kind !== 'stream') return current;
          if (page.kind === 'error') return current;
          if (page.kind === 'none') {
            return [
              {
                ...current[0],
                workspace: {
                  ...workspace,
                  runtime: { kind: 'none', because: page.because },
                },
              },
            ];
          }
          if (page.entries.length === 0) return current;
          return [
            {
              ...current[0],
              workspace: {
                ...workspace,
                runtime: {
                  ...workspace.runtime,
                  lines: [
                    ...workspace.runtime.lines,
                    ...page.entries.map((entry) => ({
                      text: `${entry.replica}  ${entry.line}`,
                    })),
                  ],
                },
              },
            },
          ];
        });
      },
    );
  }, [runtime?.componentId, runtime?.targetId]);

  // A job's runs are read the same way a service's output is — one socket, one
  // cursor — with the run named. §17's two surfaces stay distinct in what they
  // are subscribed to, not in how they are transported.
  const runs = view?.runtime.kind === 'executions' ? view.runtime : null;
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

  if (read.type === 'loading') return <DetailSkeleton />;

  if (read.type === 'error') {
    return read.failure.code === 'NOT_FOUND' ? (
      <ScreenNotFound
        title={`No App named "${appName}"`}
        message={read.failure.message}
        onNavigate={onNavigate}
      />
    ) : (
      <ScreenFailure
        title="Failed to load workspace"
        message={read.failure.message}
        width="reading"
        onRetry={read.reload}
      />
    );
  }

  const workspace = read.value[0].workspace;

  // `rebuild` is passed explicitly rather than defaulted from a bare click
  // handler: a click hands its event to the first parameter, and an event is
  // truthy, so `onClick={handleDeploy}` would silently rebuild every press.
  const handleDeploy = async (rebuild: boolean) => {
    const firstPlacement = targetForFirstDeploy(workspace);
    setDeploying(true);
    try {
      // By id where the workspace knows one: `apps` does not constrain `name`,
      // and the command refuses a name two Apps answer to rather than guessing.
      const result = await command('deployApp', {
        name: workspace.appId ?? appName,
        rebuild,
        // A deploy is a press on one Component, and the header these buttons
        // sit in reads the selected Component's kind, phase and placement — so
        // it is that Component's release they start, not the App's first one's.
        ...(workspace.componentId === undefined
          ? {}
          : { component: workspace.componentId }),
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
      read.reload();
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
    const appId = workspace.appId;
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

  // The hold (§6). Re-read, unlike the switch above: the banner, the pending
  // line and the Deploy button's refusal all derive from the lock, and the
  // control that changed it is not the one showing it.
  const handleSetLock: SetLock = async (reason) => {
    const appId = workspace.appId;
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to lock' };
    }
    try {
      const result = await command('setAppLock', { appId, reason });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Saving the lock failed',
      };
    }
  };

  // Which route this App builds on (§4, §16). No re-read, for the same reason
  // `handleSetAutoDeploy` needs none: the picker already holds the answer it
  // just wrote, and this changes exactly the field it is showing.
  /**
   * Two writes, and the zone goes first.
   *
   * `setAppZone` is the one that can be refused — it will not pin a zone that
   * cannot serve a placed Component's reach — so a label written before it
   * would land in a zone the next call rejects, leaving the App carrying half
   * an answer nobody gave.
   */
  const handleSetAppDomain: SetDomain = async ({ label, zone }) => {
    const appId = workspace.appId;
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to set a domain on' };
    }
    try {
      const pinned = await command('setAppZone', { appId, zone });
      if (!pinned.ok) return { ok: false, message: pinned.failure.message };
      const named = await command('setAppVanity', { appId, label });
      return named.ok
        ? { ok: true }
        : { ok: false, message: named.failure.message };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Saving the domain failed',
      };
    }
  };

  const handleSetAppBuildRoute: SetBuildRoute = async (route) => {
    const appId = workspace.appId;
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to set a builder on' };
    }
    try {
      const result = await command('setAppBuildRoute', { appId, route });
      return result.ok
        ? { ok: true }
        : { ok: false, message: result.failure.message };
    } catch (cause: unknown) {
      return {
        ok: false,
        message:
          cause instanceof Error ? cause.message : 'Saving the builder failed',
      };
    }
  };

  // Bytes to the depot, then a Build row that spends the digest.
  //
  // Two calls rather than one because they are two different things: staging is
  // the only thing that sees the bytes and so the only thing that can digest
  // them (§16), and `uploadArchive` "never reads the bundle" for exactly that
  // reason. A staged bundle nobody wrote a Build for is a harmless orphan the
  // depot sweeps; a Build row naming bytes that never landed would not be.
  const handleStageArchive: StageArchive = async (file) => {
    const response = await fetch(UPLOAD_PATH, {
      method: 'POST',
      headers: { 'x-filename': file.name },
      body: file,
    });
    const body = (await response.json()) as
      | { ok: true; value: StagedUpload }
      | { ok: false; failure: { message: string } };
    // The boundary's own sentence — it names what arrived, which is the whole
    // reason the refusal happens there rather than in a runner log.
    if (!body.ok) throw new Error(body.failure.message);
    return body.value;
  };

  const handleUploadArchive: SubmitUpload = async (request) => {
    try {
      // §5's scope. The control does not offer it: every archive the browser
      // sends is the whole bundle, and a subpath is a repo-shaped question.
      const result = await command('uploadArchive', {
        ...request,
        subpath: '.',
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      // Land on the attempt this started, the way `handleDeploy` does — a press
      // that produced a durable id should not leave the operator wondering.
      onNavigate(`/builds/${result.value.buildId}`);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'The upload failed',
      };
    }
  };

  // The pair this workspace is showing (§10) — bound here, once, so `SetConfig`
  // itself does not have to carry it on every call. Re-read on success for the
  // same reason `handleSetReach` is: `configKeys` is a row this act just
  // changed, and a key that was just deleted has to actually leave the list
  // rather than being patched out by a guess about what the write did.
  const handleSetConfig: SetConfig = async (change) => {
    const { componentId, targetId } = workspace;
    if (componentId === undefined || targetId === undefined) {
      return {
        ok: false,
        message: 'This App has no Component placed on a Target yet',
      };
    }
    try {
      const result = await command('setConfig', {
        componentId,
        targetId,
        entries: [...change.entries],
        removals: [...change.removals],
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
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
    const appId = workspace.appId;
    if (appId === undefined) {
      return { ok: false, message: 'This App has no id to add a Component to' };
    }
    try {
      const result = await command(
        'createComponent',
        componentCreation(appId, create),
      );
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
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
      read.reload();
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
      read.reload();
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
  const handleRunJob: RunJob = async (env) => {
    if (runs?.componentId === undefined || runs.targetId === undefined) {
      return { ok: false, message: 'This job has not been placed on a Target' };
    }
    try {
      const result = await command('runComponent', {
        componentId: runs.componentId,
        targetId: runs.targetId,
        ...(env === undefined ? {} : { env }),
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
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
    The one Datastore act an App has (§11). `handleSetConfig`'s shape: the App
    the screen is showing is bound here so the card does not restate it, the
    command's own refusal is passed through unedited, and the workspace is
    re-read on success rather than patched — `attachedTo` is a row this act
    just changed.
  */
  const handleAttachDatastore: AttachDatastore = async (datastoreId) => {
    const appId = workspace.appId;
    if (appId === undefined) {
      return {
        ok: false,
        message: 'This App has no id to attach a Datastore to',
      };
    }
    try {
      const result = await command('attachDatastore', { datastoreId, appId });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'Attaching failed',
      };
    }
  };

  return (
    <>
      <Workspace
        view={workspace}
        onDeploy={() => handleDeploy(false)}
        onRebuild={() => handleDeploy(true)}
        deploying={deploying}
        onNavigate={onNavigate}
        deletion={deletion}
        onSetReach={handleSetReach}
        onSetAutoDeploy={handleSetAutoDeploy}
        onSetLock={handleSetLock}
        onSetBuildRoute={handleSetAppBuildRoute}
        onSetDomain={handleSetAppDomain}
        onStageArchive={handleStageArchive}
        onUploadArchive={handleUploadArchive}
        onSetConfig={handleSetConfig}
        onSelectComponent={handleSelectComponent}
        onCreateComponent={handleCreateComponent}
        onMoveComponent={handleMoveComponent}
        onUnplaceComponent={handleUnplaceComponent}
        targets={targets}
        onAttachDatastore={handleAttachDatastore}
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
