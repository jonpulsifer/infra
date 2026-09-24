/**
 * The App workspace: the running App in the hero, then Overview (what is
 * running), Releases, and Config (what the next release will be).
 */
import { ChevronRight, ExternalLink, Lock } from 'lucide-react';
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

/** `pendingRelease` names the Targets still serving the previous reach. */
export type SetReach = (change: {
  readonly componentId: string;
  readonly reach: Reach;
  readonly auth: Auth;
}) => Promise<
  | { readonly ok: true; readonly pendingRelease: readonly string[] }
  | { readonly ok: false; readonly message: string }
>;

/**
 * `schedule` is sent only for a job, since the command's union is strict.
 * `command` absent means the image's own entrypoint.
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
 * `supply` carries values for keys that will not follow, so they commit with
 * the move. `demanded` is the keys a refusal asks for.
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
 * Retires one (Component, Target) pair, since a move leaves two serving.
 * `destroyed` is false when there was no workload to tear down.
 */
export type UnplaceComponent = (pair: {
  readonly componentId: string;
  readonly targetId: string;
}) => Promise<
  | { readonly ok: true; readonly destroyed: boolean }
  | { readonly ok: false; readonly message: string }
>;

/** Sends the wanted state, so two racing presses agree on the result. */
export type SetAutoDeploy = (
  autoDeploy: boolean,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/** Locks deploys with a reason; `null` unlocks. */
export type SetLock = (
  reason: string | null,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export type SetDomain = (choice: {
  /** The label, `@` for the zone itself, or null to have no name of its own. */
  readonly label: string | null;
  /** The zone to pin to, or null to take the first that serves. */
  readonly zone: string | null;
}) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/** `null` clears the choice back to rank order. */
export type SetBuildRoute = (
  route: string | null,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/**
 * `env` is this run's parameters; `runComponent` refuses a name that config
 * already sets.
 */
export type RunJob = (
  env?: Readonly<Record<string, string>>,
) => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

export type RestartService = () => Promise<
  { readonly ok: true } | { readonly ok: false; readonly message: string }
>;

/** Writes and removes keys in one call; setting an existing key overwrites it. */
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
  onRestartService,
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
  /** Pass both or neither: the upload command spends the staged digest. */
  onStageArchive?: StageArchive;
  onUploadArchive?: SubmitUpload;
  onDeploy?: () => void;
  /** Always starts a Build, whatever is already built. */
  onRebuild?: () => void;
  deploying?: boolean;
  onNavigate?: (path: string) => void;
  deletion?: AppDeletionControls;
  onSetReach?: SetReach;
  onSetConfig?: SetConfig;
  /** Selects another Component of this App, by name. */
  onSelectComponent?: (component: string) => void;
  onCreateComponent?: CreateComponent;
  onMoveComponent?: MoveComponent;
  onUnplaceComponent?: UnplaceComponent;
  /** The Targets a move picks from. Move is not offered while this is empty. */
  targets?: readonly TargetListItem[];
  onRunJob?: RunJob;
  onRestartService?: RestartService;
  onSetAutoDeploy?: SetAutoDeploy;
  onSetLock?: SetLock;
  onSetBuildRoute?: SetBuildRoute;
  onSetDomain?: SetDomain;
  onAttachDatastore?: AttachDatastore;
  /** `null` stops following. */
  onFollowExecution?: (execution: string | null) => void;
  /** The lines of whichever run is being followed. */
  executionLines?: readonly LogLine[];
  /**
   * ponytail: the tab lives in state, since `app.tsx` reads everything after
   * `/apps/` as the App name. A tab is not linkable and survives no reload.
   */
  tab?: WorkspaceTab;
}) {
  // A view with no `componentId` is showing the App's first Component.
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
            {/* By id: two Apps can share a name. */}
            {deletion && view.appId ? (
              <DeleteAppButton
                appId={view.appId}
                name={view.app}
                deletion={deletion}
                label
              />
            ) : null}
            {/* A job has no address, and an empty href reloads this screen. */}
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
            {/* "Deploy" for every kind: for a job it places the CronJob without
                running it. Run now is on the runtime card. */}
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

      {/* Above the tabs, so a failure or drift shows on every tab. */}
      {view.diagnosis ? (
        <DiagnosisPanel
          diagnosis={view.diagnosis}
          // This screen does not read whether an older release is still up;
          // the release screen says so.
          previousReleaseServing={false}
          url={view.url}
        />
      ) : null}
      {/* A faulty release's drift is what the soak judged, so the drift panel yields. */}
      {view.drift && !view.faulty ? (
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
          {view.components.length === 0 ? (
            <Card>
              <CardContent>
                <EmptyState title="This App has no Components yet.">
                  A Component is what gets built and placed. The Config tab
                  declares one.
                </EmptyState>
              </CardContent>
            </Card>
          ) : (
            <Topology
              components={view.components}
              datastores={view.datastores}
              {...(selected === undefined ? {} : { selectedId: selected.id })}
              {...(onSelectComponent === undefined
                ? {}
                : { onSelect: onSelectComponent })}
              {...(onNavigate ? { onNavigate } : {})}
            >
              {selected === undefined ? null : (
                <SelectedComponent key={selected.id} component={selected} />
              )}
            </Topology>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {/* Un-sliced: `getAppWorkspace` already bounds the entries. */}
            <Activity entries={view.activity} onNavigate={onNavigate} />
            <Runtime
              view={view}
              {...(selected === undefined ? {} : { component: selected.name })}
              onNavigate={onNavigate}
              {...(onRunJob ? { onRun: onRunJob } : {})}
              {...(onRestartService ? { onRestart: onRestartService } : {})}
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
          {/* By id: two Apps can share a name. */}
          {view.appId === undefined ? null : <SourceSection app={view.appId} />}
          {/* No options for an archive App or one with no Target placed yet. */}
          {view.buildRouteOptions.length > 0 && onSetBuildRoute ? (
            <BuildRoutePicker
              buildRoute={view.buildRoute}
              options={view.buildRouteOptions}
              onSetBuildRoute={onSetBuildRoute}
            />
          ) : null}
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

export type WorkspaceTab = 'overview' | 'releases' | 'config';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'releases', label: 'Releases' },
  { id: 'config', label: 'Config' },
] as const satisfies readonly { id: WorkspaceTab; label: string }[];

/**
 * Names the Component, since everything beside it is that Component's. A LIVE
 * one with no address reads "deployed": a job or unrouted service never serves.
 */
function heroHeadline(view: WorkspaceView, component?: ComponentView): string {
  const subject = component?.name ?? 'Your App';
  // The soak's verdict outranks a live address.
  if (view.faulty) return `${subject} is faulty`;
  if (view.url === '') {
    return view.phase === 'LIVE'
      ? `${subject} is deployed`
      : `${subject} has no release yet`;
  }
  return view.urlLive
    ? `${subject} is live`
    : `${subject} has no release serving yet`;
}

function Hero({
  view,
  component,
  onNavigate,
  onSetAutoDeploy,
  onSetLock,
}: {
  view: WorkspaceView;
  /** Absent for an App with no Components yet. */
  component?: ComponentView;
  onNavigate?: (path: string) => void;
  onSetAutoDeploy?: SetAutoDeploy;
  onSetLock?: SetLock;
}) {
  // `release` names the Deploy where there is one, else the Build.
  const releasePath =
    view.latestDeployId !== undefined
      ? `/deploys/${view.latestDeployId}`
      : view.latestBuildId !== undefined
        ? `/builds/${view.latestBuildId}`
        : null;

  // An App with no repository connected has no `source.url`, so no commit links.
  const repo = view.source?.url;
  const commitUrl = (sha: string) =>
    repo === undefined ? {} : { href: `${repo}/commit/${sha}` };

  const policy =
    (view.autoDeploy !== null && onSetAutoDeploy) ||
    (view.lock === undefined && onSetLock);

  return (
    <Card className="flex flex-wrap items-start gap-6 px-5 py-5">
      {view.lock ? (
        <LockBanner
          lock={view.lock}
          {...(onSetLock === undefined ? {} : { onSetLock })}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <PhasePill phase={view.phase} faulty={view.faulty} />
        <p className="text-xl font-semibold tracking-tight">
          {heroHeadline(view, component)}
        </p>
        {/* An empty href reloads this screen. */}
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
        {view.commit || view.at ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {view.commit ? (
              <Ref
                value={view.commit}
                kind="commit"
                headline={view.commitMessage}
                {...commitUrl(view.commit)}
              />
            ) : null}
            {view.at ? (
              <Timestamp at={view.at} when={view.when} className="font-mono" />
            ) : null}
          </div>
        ) : null}
        {/* The adopted commit is ahead of the serving one. Deploy alone would
            place the artifact already built, so Rebuild is what ships it. */}
        {view.source?.pending ? (
          <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{view.source.branch}</span> is at{' '}
            <Ref
              value={view.source.pending.commit}
              kind="commit"
              {...commitUrl(view.source.pending.commit)}
            />
            , live is{' '}
            {view.commit ? (
              <Ref
                value={view.commit}
                kind="commit"
                {...commitUrl(view.commit)}
              />
            ) : (
              'nothing'
            )}
            {' — '}
            {view.lock
              ? 'held by the lock'
              : view.source.pending.dispatched
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
      </div>

      {/* The negative margins run the top rule to the card's edges. */}
      {policy ? (
        <div className="-mx-5 -mb-5 mt-1 flex basis-full flex-wrap items-center gap-3 border-t border-border-soft px-5 py-3">
          <Eyebrow>Deploy policy</Eyebrow>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {/* `autoDeploy` is null for an archive App, which receives no push. */}
            {view.autoDeploy !== null && onSetAutoDeploy ? (
              <AutoDeployToggle
                autoDeploy={view.autoDeploy}
                onSetAutoDeploy={onSetAutoDeploy}
              />
            ) : null}
            {/* Only while unlocked: the banner above lifts a lock. */}
            {view.lock === undefined && onSetLock ? (
              <LockControl onSetLock={onSetLock} />
            ) : null}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

/** Read-only without `onSetLock`: the lock explains why Deploy refuses. */
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
 * Locks deploys by hand. The reason is required: the banner shows it to
 * whoever meets the refusal next.
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
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Lock aria-hidden="true" />
        Lock deploys
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col items-end gap-1.5"
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

/** Names each unmet prerequisite. The Targets screen composes the fix. */
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

/** Optimistic: the label flips at once and reverts if the command refuses. */
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
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={flip}
        disabled={saving}
        // A standing state, which screen readers announce as a switch.
        role="switch"
        aria-checked={on}
        className={cn(
          'inline-flex h-8 items-center gap-2 rounded-sm border px-2.5 text-xs',
          'transition-colors duration-100 ease-out disabled:opacity-50',
          on
            ? 'border-primary/40 bg-accent text-accent-foreground'
            : 'border-border text-muted-foreground hover:border-primary hover:text-foreground',
        )}
      >
        {/* The track and thumb animate only transform and background-color,
            so a press never reflows the row. */}
        <span
          aria-hidden="true"
          className={cn(
            'relative inline-block h-4 w-7 shrink-0 rounded-full transition-colors duration-150 ease-out',
            on ? 'bg-primary' : 'bg-border',
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 left-0.5 size-3 rounded-full bg-card transition-transform duration-150 ease-out',
              on && 'translate-x-3',
            )}
          />
        </span>
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
 * The "Rank order" tile sends `null`. Optimistic, like
 * {@link AutoDeployToggle}: the tile reverts if the command refuses.
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
      {/* Both or neither: a verb with no handler is a dead button. */}
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
   * Makes the badge and text one button. `trailing` stays outside it, since a
   * button cannot nest another.
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
      {/* The chevron promises a destination, so only a pressable row draws one. */}
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

function Fact({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="min-w-0">
      <Eyebrow>{label}</Eyebrow>
      <p className={cn('truncate text-body', mono && 'font-mono')}>{value}</p>
    </div>
  );
}

/**
 * The caller keys this on the Component's id, so a new selection remounts it
 * and the strip rises again.
 */
function SelectedComponent({ component }: { component: ComponentView }) {
  return (
    <div className="flex flex-wrap items-start gap-x-8 gap-y-3 motion-safe:animate-rise">
      <div className="min-w-0">
        <Eyebrow>{component.kind}</Eyebrow>
        <p className="truncate text-ui font-semibold tracking-tight">
          {component.name}
        </p>
      </div>
      <Fact
        label="Reach"
        value={
          component.auth === 'proxy'
            ? `${component.reach} · proxy`
            : component.reach
        }
        mono
      />
      <Fact label="Artifact" value={component.artifact} mono />
      <Fact
        label="Placement"
        value={component.target ?? 'not placed yet'}
        mono
      />
      {component.when ? <Fact label="Released" value={component.when} /> : null}
    </div>
  );
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
  selectedId?: string;
  onSetReach?: SetReach;
  onSelectComponent?: (component: string) => void;
  onCreateComponent?: CreateComponent;
  onMoveComponent?: MoveComponent;
  onUnplaceComponent?: UnplaceComponent;
  targets?: readonly TargetListItem[];
  /** Every Datastore this App reads through, plus the unattached ones. */
  datastores?: readonly DatastoreView[];
  /** Opens a Datastore's own screen. */
  onNavigate?: (path: string) => void;
  onAttachDatastore?: AttachDatastore;
}) {
  // Separate slots, so opening Move does not cancel Reach.
  const [editing, setEditing] = useState<string | null>(null);
  const [placing, setPlacing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Both or neither: a move without Unplace strands the pair it left.
  const movable =
    onMoveComponent && onUnplaceComponent && targets.length > 0
      ? { onMoveComponent, onUnplaceComponent }
      : null;

  return (
    <Card>
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
        {components.length === 0 ? (
          <EmptyState title="This App has no Components yet.">
            A Component is what gets built and placed.{' '}
            {onCreateComponent
              ? 'Add Component declares one.'
              : 'The create flow declares the first one.'}
          </EmptyState>
        ) : null}
        {components.map((component) => {
          // Offered only where a pair serves: the first Deploy writes a first
          // placement.
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
 * The picker offers only unattached stores. Other refusals come back from
 * `attachDatastore`.
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
 * Writes the Component row only: the first Deploy builds and places it.
 * `kind` sets the opening tile, since the test DOM shim cannot press one.
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
        // Only a job takes `schedule`, and an empty string is not a cron expression.
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
 * Saves the Component only: the chart renders reach at deploy time. Exported
 * because it sits behind a disclosure the test DOM shim cannot open.
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
        // `reach: none` has no route to authenticate in front of.
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
 * A refused move retries as the same call with `supply` filled in. Exported
 * because the test DOM shim cannot open its disclosure.
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
        {/* One control per pair: `unplaceComponent` retires by (Component, Target). */}
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
 * Asks for the values a move cannot carry, under core's own refusal sentence.
 * Exported so tests can render the refusal without a press.
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
 * Reads once per visit: `getAppSource` calls the repository host, and the
 * workspace read repeats every two seconds while a release is in flight.
 */
function SourceSection({ app }: { app: string }) {
  const read = useRead([['getAppSource', { app }]], null, [app]);
  const source = read.type === 'success' ? read.value[0].source : null;
  if (source === null) return null;

  const { manifest } = source;
  // Pinned to the commit `getAppSource` read, so the link survives a push.
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
            /* An unread file is "unknown": "detected" would be a guess. */
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
 * The App's vanity name. `@` is the zone apex and never shows on screen; the
 * record publishes on the next deploy.
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
          {/* An apex record is published once and never re-pointed; see `isApexName`. */}
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
            {/* The deploy loop writes the DNS record, not this button. */}
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
  /** Absent for an App with no Components yet. */
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

/** Starts blank even for an existing key: a value is never read back. */
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
 * Removes one key. A refusal goes to `onError`, since the row has no room to
 * show one. Exported so tests can call it directly.
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

/** The checkpoint timeline, newest first. */
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
            <span
              aria-hidden="true"
              className="absolute left-[5px] top-3 bottom-3 w-px bg-border-soft"
            />
            {/* Keyed by position: two checkpoints can read alike, and rows
                hold no state. */}
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
      {/* The bg-card fill on an info marker hides the rule behind it. */}
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
 * A service's output is a stream with Deploys as markers, a job's is a list of
 * runs, and a Component with no process gets an empty state.
 */
function Runtime({
  view,
  component,
  onNavigate,
  onRun,
  onRestart,
  onFollowExecution,
  executionLines,
}: {
  view: WorkspaceView;
  component?: string;
  onNavigate?: (path: string) => void;
  onRun?: RunJob;
  onRestart?: RestartService;
  /**
   * `null` stops following. Lines arrive as `executionLines`, since the screen
   * above owns the socket.
   */
  onFollowExecution?: (execution: string | null) => void;
  executionLines?: readonly LogLine[];
}) {
  const runtime = view.runtime;
  const latestDeployId = view.latestDeployId;
  const [following, setFollowing] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  // A row with no name is unfilled, so `start` skips it.
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
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const restart = async () => {
    if (!onRestart) return;
    setRestarting(true);
    setRestartError(null);
    const result = await onRestart();
    setRestarting(false);
    if (!result.ok) setRestartError(result.message);
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
            {/* Run now sits with the runs: running changes nothing that is placed. */}
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
                {/* A parameter is not a secret, so the value is plain text.
                    `runComponent` refuses a name that config already sets. */}
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
            {/* A failed read says why, so it does not claim the job never ran. */}
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
                {/* Pressing the open run again closes the pane and its socket. */}
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
            {/* `retained` is the page size asked for, not a retention promise:
                Cloud Run keeps its own history. */}
            {runtime.because ? null : (
              <p className="pt-2 text-xs text-muted-foreground">
                Showing the last {runtime.retained} runs. The history lives on
                the Target, not here.
              </p>
            )}
          </>
        ) : (
          <>
            {/* Restart sits with the output: it replaces the process and changes
                nothing that is placed. */}
            {onRestart ? (
              <div className="flex items-center gap-3 pb-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={restarting}
                  onClick={() => void restart()}
                >
                  {restarting ? 'Restarting...' : 'Restart'}
                </Button>
                {restartError ? (
                  <p className="text-xs text-destructive">{restartError}</p>
                ) : null}
              </div>
            ) : null}
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
 * `runtime.lines` grows for as long as the screen is open, so the pane renders
 * only this many of the newest.
 */
const TAIL_LINES = 2_000;

/** `follow` scrolls to the newest line and caps the pane's height. */
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
 * Keeps what the socket knows across a refresh: the read returns `stream` with
 * no lines for any placed Component. Lines survive for the same Component and
 * Target, and a `none` also needs the same Deploy and phase.
 *
 * ponytail: a runtime that recovers on the same LIVE release keeps saying
 * `none` until the selection changes or the page reloads.
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
 * An unplaced Component deploys to a sibling's Target, since `deployApp`
 * refuses to guess one. A placed Component names none: that would be a move.
 */
export function targetForFirstDeploy(view: WorkspaceView): string | undefined {
  if (view.targetId !== undefined) return undefined;
  return view.components.find((component) => component.target !== undefined)
    ?.target;
}

/** ponytail: splits on whitespace only, so a quoted argument is split too. */
export function argvOf(entrypoint: string): string[] {
  return entrypoint.trim().split(/\s+/);
}

/**
 * Restates the schema defaults for `reach`, `auth` and `expose`, since
 * `InputOf` is the schema's output type.
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
        // Omitted for an unscheduled job, which deploys as a suspended CronJob.
        ...(create.schedule === undefined ? {} : { schedule: create.schedule }),
      };
  }
}

/**
 * Reads the demanded keys from `issues` at `supply.<KEY>`, never from the
 * message. Every other refusal gives `[]`.
 */
export function demandedKeys(failure: TransportFailure): readonly string[] {
  return (failure.issues ?? [])
    .filter((issue) => issue.path.startsWith('supply.'))
    .map((issue) => issue.path.slice('supply.'.length));
}
/**
 * An empty `appName` is answered before `AppWorkspace`, so its hooks run
 * unconditionally.
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
  // `null` lets the server pick the App's first Component.
  const [component, setComponent] = useState<string | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const [runLines, setRunLines] = useState<readonly LogLine[]>([]);

  const deletion = useAppDeletion(() => onNavigate('/apps'));

  // A failed read leaves this empty, which hides Move.
  const targetList = useRead([['listTargets', {}]], null);
  const targets =
    targetList.type === 'success' ? targetList.value[0].targets : [];

  // The selection is sent on every read and is in `deps`, so a response for a
  // Component the screen has left is dropped.
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
        // `none` and `error` replace the pane, so unreadable logs never look
        // like a run that printed nothing.
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

  // Never pass this as a click handler: the event would arrive as a truthy
  // `rebuild`.
  const handleDeploy = async (rebuild: boolean) => {
    const firstPlacement = targetForFirstDeploy(workspace);
    setDeploying(true);
    try {
      // By id where known: two Apps can share a name.
      const result = await command('deployApp', {
        name: workspace.appId ?? appName,
        rebuild,
        // Deploys the selected Component, the one the header describes.
        ...(workspace.componentId === undefined
          ? {}
          : { component: workspace.componentId }),
        ...(firstPlacement === undefined ? {} : { target: firstPlacement }),
      });
      if (result.ok) {
        onNavigate(
          result.value.deployId === null
            ? `/builds/${result.value.buildId}`
            : `/deploys/${result.value.deployId}`,
        );
      } else {
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

  // No re-read: the toggle already shows the value it wrote.
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

  // Re-read: the banner, the pending line and Deploy all derive from the lock.
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

  // The zone goes first: `setAppZone` can refuse, and a label written before
  // it would leave half an answer.
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

  // No re-read: the picker already shows the value it wrote.
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

  // Two calls: staging is the only step that sees the bytes, so it digests
  // them, and `uploadArchive` spends the digest.
  const handleStageArchive: StageArchive = async (file) => {
    const response = await fetch(UPLOAD_PATH, {
      method: 'POST',
      headers: { 'x-filename': file.name },
      body: file,
    });
    const body = (await response.json()) as
      | { ok: true; value: StagedUpload }
      | { ok: false; failure: { message: string } };
    if (!body.ok) throw new Error(body.failure.message);
    return body.value;
  };

  const handleUploadArchive: SubmitUpload = async (request) => {
    try {
      // A browser upload is the bundle itself, so its subpath is always `.`.
      const result = await command('uploadArchive', {
        ...request,
        subpath: '.',
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      onNavigate(`/builds/${result.value.buildId}`);
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'The upload failed',
      };
    }
  };

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

  // A run name belongs to the old Component, so the open tail closes.
  const handleSelectComponent = (name: string) => {
    setFollowing(null);
    setComponent(name);
  };

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

  // No confirmation: Unplace on a named pair is the request.
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

  const handleRestartService: RestartService = async () => {
    if (runtime === null) {
      return {
        ok: false,
        message: 'This service has not been placed on a Target',
      };
    }
    try {
      const result = await command('restartComponent', {
        componentId: runtime.componentId,
        targetId: runtime.targetId,
      });
      if (!result.ok) return { ok: false, message: result.failure.message };
      read.reload();
      return { ok: true };
    } catch (cause: unknown) {
      return {
        ok: false,
        message: cause instanceof Error ? cause.message : 'The restart failed',
      };
    }
  };

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
        {...(runtime === null
          ? {}
          : { onRestartService: handleRestartService })}
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
