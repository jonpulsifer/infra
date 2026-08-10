/**
 * The App workspace (Task 40, §18).
 *
 * **Live state and URL lead**, then the placement — Target and the vessel it
 * is a surface on — then Components and Datastores as **peer actionable
 * sections**, then a dense activity timeline. The peering is the decision worth
 * protecting: a Datastore is a top-level noun that an App attaches (§11), never
 * a field on the App, and a layout that nests it under Components would quietly
 * say the opposite.
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
 *   the section below Components and Datastores is a list of names and a form
 *   that writes — there is nothing here that could show a secret it was handed
 *   by accident, because nothing here is ever handed one.
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
import { type ReactNode, useState } from 'react';
import type { Auth, Reach } from '../../../domain/desired-state.ts';
import {
  type AppDeletionControls,
  DeleteAppButton,
} from '../../components/delete-app.tsx';
import { DiagnosisPanel, DriftPanel } from '../../components/diagnosis.tsx';
import { EmptyState, LogPane } from '../../components/log-pane.tsx';
import { PhasePill } from '../../components/status.tsx';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  LogLine,
  PrerequisiteRowView,
  WorkspaceView,
} from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, Eyebrow } from '../../ui/card.tsx';
import { Ref } from '../../ui/copy.tsx';
import { Field } from '../../ui/field.tsx';
import { Page, PageHeader } from '../../ui/page.tsx';
import { Tabs } from '../../ui/tabs.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { cn, normaliseUrl } from '../../ui/utils.ts';
import {
  AUTH_NOTE,
  AUTHS,
  Choice,
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
 * Starting one run of a job, as the screen above needs it answered (§17).
 *
 * The same shape {@link SetReach} takes and for the same reason: the press has
 * exactly one thing to say afterwards — it started, or here is the sentence the
 * command refused with — and threading that back as two props would put this
 * card's transient state on the screen that owns the App.
 */
export type RunJob = () => Promise<
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
 * Creating one managed Datastore on the Target this workspace is placed on
 * (§11), as the screen above needs it answered.
 *
 * No Target on the shape, for the reason {@link SetConfig} carries no pair: the
 * workspace has exactly one placement on screen and the screen above binds it
 * once. No variable name either, ever — the name a connection is read through
 * is fixed by engine (`DATABASE_URL`, `REDIS_URL`), so offering a field for it
 * would be offering a choice that core does not accept.
 */
export type CreateDatastore = (create: {
  readonly name: string;
  readonly engine: 'postgres' | 'valkey';
}) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * Attaching, detaching or destroying one Datastore, by id.
 *
 * One shape for the three because they take the same argument and answer the
 * same question — the App is bound by the screen above, exactly as it is for
 * {@link SetConfig}, and every refusal these three carry is a sentence core
 * composed. Three separate types would differ only in their name.
 */
export type DatastoreAct = (
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
  onRunJob,
  onSetAutoDeploy,
  onCreateDatastore,
  onAttachDatastore,
  onDetachDatastore,
  onDestroyDatastore,
  onFollowExecution,
  executionLines,
  tab = 'overview',
}: {
  view: WorkspaceView;
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
   * The four acts a Datastore has (§11). Absent where the screen wires no acts,
   * for the same reason {@link onSetReach} is.
   *
   * `onCreateDatastore` is additionally absent where the placed Target's
   * adapter cannot provision one — see the call site below, which decides it on
   * the **adapter type** rather than on what the adapter claims to serve.
   */
  onCreateDatastore?: CreateDatastore;
  onAttachDatastore?: DatastoreAct;
  onDetachDatastore?: DatastoreAct;
  onDestroyDatastore?: DatastoreAct;
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
          <div className="grid gap-4 md:grid-cols-2">
            <Components
              components={view.components}
              {...(selected === undefined ? {} : { selectedId: selected.id })}
              {...(onSetReach === undefined ? {} : { onSetReach })}
              {...(onSelectComponent === undefined
                ? {}
                : { onSelectComponent })}
            />
            {/*
              Creating is offered on a `kubernetes` placement and nowhere else,
              and the test is the **adapter type**, not what the adapter says it
              serves: the cloud adapter claims both engines deliberately and
              throws `UNIMPLEMENTED` from every verb, because a Vessel carries
              no network to place a private endpoint in. Asking by engine would
              render a form whose every submission is refused. The other three
              stay offered whatever the placement: they act on rows that already
              exist, and a Datastore that got created somehow — externally
              registered, or created while the App sat on another Target — is
              still one an operator has to be able to detach.
            */}
            <Datastores
              datastores={view.datastores}
              {...(onCreateDatastore && view.target === 'kubernetes'
                ? { onCreateDatastore }
                : {})}
              {...(onAttachDatastore ? { onAttachDatastore } : {})}
              {...(onDetachDatastore ? { onDetachDatastore } : {})}
              {...(onDestroyDatastore ? { onDestroyDatastore } : {})}
            />
          </div>
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
        <ConfigSection
          configKeys={view.configKeys}
          {...(selected === undefined ? {} : { component: selected.name })}
          {...(onSetConfig === undefined ? {} : { onSetConfig })}
        />
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
 * timeline). Logs, Components and Datastores are all answers to "what is this
 * App doing right now", which is Overview, and splitting them would make the
 * common visit three clicks instead of none.
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
}: {
  view: WorkspaceView;
  /** The Component this card is about. Absent for an App with none yet. */
  component?: ComponentView;
  onNavigate?: (path: string) => void;
  onSetAutoDeploy?: SetAutoDeploy;
}) {
  return (
    <Card className="flex flex-wrap items-start gap-6 px-5 py-5">
      <div className="flex flex-col gap-2">
        <PhasePill phase={view.phase}>{view.phase}</PhasePill>
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
        */}
        {view.latestDeployId !== undefined && onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(`/deploys/${view.latestDeployId}`)}
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
            {view.commit ? <Ref value={view.commit} kind="commit" /> : null}
            {view.at ? (
              <Timestamp at={view.at} when={view.when} className="font-mono" />
            ) : null}
          </div>
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
      </div>
    </Card>
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
        four buttons on this screen do nothing when pressed: `Add Component`
        and `Attach Datastore` never had a handler at all, and the runtime
        card's own verb loses one whenever the Component has no release to open.
        A section that cannot answer its verb does not offer it.
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
        every row with no trailing control — config keys, attached Datastores,
        job runs — each of which advertised a navigation it did not have.
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
}: {
  components: readonly ComponentView[];
  /** The row this screen's runtime, config and placement are about. */
  selectedId?: string;
  onSetReach?: SetReach;
  onSelectComponent?: (component: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <Card>
      {/*
        No action. `SectionHeader` renders the button whether or not an
        `onAction` was passed, so "Add Component" was a control that did
        nothing on press — worse than no control, because it reads as a feature
        that is broken rather than one that is not built. Components are
        declared in the create flow; when adding one from here exists, the verb
        comes back with a handler.
      */}
      <SectionHeader eyebrow="App structure" title="Components" />
      <CardContent className="pt-0">
        {/* The length guard every sibling card has. A brand-new App rendered
            an empty card under a dead button. */}
        {components.length === 0 ? (
          <EmptyState title="This App has no Components yet.">
            A Component is what gets built and placed. The create flow declares
            the first one.
          </EmptyState>
        ) : null}
        {components.map((component) => (
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
                onSetReach ? (
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
          </div>
        ))}
      </CardContent>
    </Card>
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
 * What one Datastore's row says.
 *
 * The phase is in the line rather than in the badge, which stays the engine —
 * the engine is what a reader scans this column for, and it is the fact that
 * decides which variable the connection arrives on. Without the phase the row
 * read as finished the instant it was asked for: a CloudNativePG cluster takes
 * minutes to bootstrap, and `postgres · managed · Metal` said nothing about
 * which of those minutes this is. `detail` is the operator's own sentence and
 * is stated only where there is one, so an ordinary row is not padded with an
 * empty segment.
 */
function datastoreDetail(datastore: DatastoreView): string {
  const parts = [
    datastore.provenance,
    datastore.target,
    datastore.phase,
    datastore.attachedTo ? `attached to ${datastore.attachedTo}` : 'unattached',
  ];
  if (datastore.detail) parts.push(datastore.detail);
  return parts.join(' · ');
}

/**
 * §11: Datastores are top-level and attached, never a field. An unattached one
 * is still listed — it exists whether or not this App uses it, and attaching it
 * is an act with placement consequences (§3), not a toggle.
 *
 * **Every act is a command, and every refusal is core's sentence.** Attaching
 * carries the rules — one store per engine per App, cluster-local placement —
 * and destroying refuses while attached, so nothing here guesses at whether a
 * button will be accepted; it presses, and reports what came back. The one
 * refusal composed on this side is the absence of a handler, which is the
 * both-or-neither rule the section header already enforces.
 */
function Datastores({
  datastores,
  onCreateDatastore,
  onAttachDatastore,
  onDetachDatastore,
  onDestroyDatastore,
}: {
  datastores: readonly DatastoreView[];
  onCreateDatastore?: CreateDatastore;
  onAttachDatastore?: DatastoreAct;
  onDetachDatastore?: DatastoreAct;
  onDestroyDatastore?: DatastoreAct;
}) {
  const [adding, setAdding] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  /*
    One refusal line for the whole section, the way `ConfigSection` keeps one
    for its deletes: a row has nowhere to put a sentence, and three buttons that
    each swallowed their own would lose the only thing a press produces when it
    is refused.
  */
  const act = (run: DatastoreAct, id: string) => {
    setRefusal(null);
    void run(id).then((result) => {
      if (!result.ok) setRefusal(result.message);
    });
  };

  return (
    <Card>
      <SectionHeader
        eyebrow="Attached resources"
        title="Datastores"
        {...(onCreateDatastore
          ? {
              action: adding ? 'Close' : 'Create Datastore',
              onAction: () => setAdding((current) => !current),
            }
          : {})}
      />
      <CardContent className="pt-0">
        {onCreateDatastore && adding ? (
          <NewDatastoreForm
            onCreateDatastore={onCreateDatastore}
            onDone={() => setAdding(false)}
          />
        ) : null}
        {refusal ? (
          <p className="mb-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
            {refusal}
          </p>
        ) : null}
        {datastores.length === 0 ? (
          <EmptyState title="No Datastores attached.">
            Attach an existing Postgres or Redis Datastore, or create a managed
            one. A website cannot attach one.
          </EmptyState>
        ) : (
          datastores.map((datastore) => (
            <Row
              key={datastore.id}
              badge={
                <Badge tone={datastore.attachedTo ? 'success' : 'idle'}>
                  {datastore.engine}
                </Badge>
              }
              title={datastore.name}
              detail={datastoreDetail(datastore)}
              trailing={
                <div className="flex shrink-0 items-center gap-1">
                  {/*
                    Attach or detach, never both: the row already says which it
                    is, and offering the act it is not in would be a button
                    whose only outcome is core's refusal.
                  */}
                  {datastore.attachedTo === null && onAttachDatastore ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => act(onAttachDatastore, datastore.id)}
                    >
                      Attach
                    </Button>
                  ) : null}
                  {datastore.attachedTo !== null && onDetachDatastore ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => act(onDetachDatastore, datastore.id)}
                    >
                      Detach
                    </Button>
                  ) : null}
                  {onDestroyDatastore ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => act(onDestroyDatastore, datastore.id)}
                    >
                      Destroy
                    </Button>
                  ) : null}
                </div>
              }
            />
          ))
        )}
        {/*
          Which variable it arrives on, said once for the section rather than
          per row. It is fixed by engine and there is no form field for it
          anywhere, so this line is the only place a developer finds out what
          their container will be handed.
        */}
        <p className="pt-2 text-xs text-muted-foreground">
          A Postgres connection arrives as DATABASE_URL and a Valkey one as
          REDIS_URL, on the next Deploy — attaching writes a row, it does not
          restart what is running.
        </p>
      </CardContent>
    </Card>
  );
}

/**
 * Creating one managed Datastore — a name and an engine, and nothing else.
 *
 * **No variable-name field, and there never will be one.** The connection is
 * read through a name fixed by engine, pinned into the release by
 * `createDeploy` and rendered by the chart; a field here could only disagree
 * with all three. Size is the same decision made the other way: `storageGiB` is
 * a defaulted command input, reachable over the API, because a developer has no
 * basis on day one for a number that a resize command would own.
 */
function NewDatastoreForm({
  onCreateDatastore,
  onDone,
}: {
  onCreateDatastore: CreateDatastore;
  onDone: () => void;
}) {
  const [name, setName] = useState('');
  const [engine, setEngine] = useState<'postgres' | 'valkey'>('postgres');
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<
    | { readonly kind: 'created' }
    | { readonly kind: 'refused'; readonly message: string }
    | null
  >(null);

  const save = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onCreateDatastore({ name: name.trim(), engine });
      if (result.ok) {
        setOutcome({ kind: 'created' });
        setName('');
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
        name="datastore-name"
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder="primary"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        {/* The same tiles the creation flow states reach and auth with, so a
            developer meets the choice grid once rather than per screen. */}
        <Choice
          selected={engine === 'postgres'}
          title="postgres"
          note="Arrives as DATABASE_URL"
          onClick={() => setEngine('postgres')}
        />
        <Choice
          selected={engine === 'valkey'}
          title="valkey"
          note="Arrives as REDIS_URL"
          onClick={() => setEngine('valkey')}
        />
      </div>
      {outcome?.kind === 'refused' ? (
        <p className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-xs text-destructive">
          {outcome.message}
        </p>
      ) : null}
      {outcome?.kind === 'created' ? (
        <p className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-xs">
          Created and attached. It provisions in the background — the row says
          how far it has got, and the connection reaches a container on the next
          Deploy.
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
          {saving ? 'Creating…' : 'Create Datastore'}
        </Button>
        <Button variant="ghost" size="sm" onClick={onDone} disabled={saving}>
          {outcome?.kind === 'created' ? 'Close' : 'Cancel'}
        </Button>
      </div>
    </div>
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
            {entries.map((entry) => (
              <ActivityRow
                key={`${entry.title}-${entry.when}-${entry.deployId ?? entry.buildId}`}
                entry={entry}
                onNavigate={onNavigate}
              />
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

  const follow = (execution: string) => {
    const next = following === execution ? null : execution;
    setFollowing(next);
    onFollowExecution?.(next);
  };

  const start = async () => {
    if (!onRun) return;
    setStarting(true);
    setRunError(null);
    const result = await onRun();
    setStarting(false);
    if (!result.ok) setRunError(result.message);
  };

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
              <div className="flex items-center gap-3 pb-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={starting}
                  onClick={() => void start()}
                >
                  {starting ? 'Starting...' : 'Run now'}
                </Button>
                {runError ? (
                  <p className="text-xs text-destructive">{runError}</p>
                ) : null}
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
