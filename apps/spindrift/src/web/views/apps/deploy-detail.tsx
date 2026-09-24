/**
 * The attempt screen: state and URL first, then diagnosis, the release, its
 * resources and the logs. A Build with no Deploy renders here with a null `id`.
 */
import {
  ArrowLeft,
  Ban,
  ChevronRight,
  ExternalLink,
  FileText,
  RefreshCw,
  Rocket,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type DeployPhase,
  type DeployView,
  isInFlight,
  type SourceView,
  type StepStatus,
} from '../../../commands/views.ts';
import { BUILD_ADAPTER } from '../../client/build-adapters.ts';
import { command } from '../../client.ts';
import { Checklist } from '../../components/checklist.tsx';
import { DiagnosisPanel, DriftPanel } from '../../components/diagnosis.tsx';
import { LogPane, Notice } from '../../components/log-pane.tsx';
import {
  type Stage as ProgressStage,
  StageProgress,
} from '../../components/progress.tsx';
import { flyover } from '../../components/roflcopter.tsx';
import { formatDuration, RunningTime } from '../../components/running-time.tsx';
import { PhasePill, StepGlyph, statusWord } from '../../components/status.tsx';
import { subscribeAttempt } from '../../stream-client.ts';
import { ATTEMPT_LOG_TEXT_PATH } from '../../stream-path.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { CopyButton } from '../../ui/copy.tsx';
import { Logo } from '../../ui/logo.tsx';
import { Page } from '../../ui/page.tsx';
import { notify } from '../../ui/toast.tsx';
import { cn, normaliseUrl } from '../../ui/utils.ts';
import { DetailSkeleton, ScreenFailure, ScreenNotFound } from '../screen.tsx';

/** `busy` names the act in flight, so only one button reads as working. */
export interface AttemptActions {
  /** Deploys the App's newest artifact, or builds one if there is none. */
  readonly onRedeploy?: () => void;
  readonly onRollback?: () => void;
  readonly onDeployBuild?: () => void;
  readonly onCancel?: () => void;
  readonly onCancelDeploy?: () => void;
  /**
   * A cancel already asked of the running Build, which its route answers at
   * its next poll.
   */
  readonly cancelRequested?: boolean;
  readonly busy?: 'redeploy' | 'rollback' | 'deploy' | 'cancel' | null;
}

export function DeployDetail({
  view,
  actions = {},
  onNavigate,
}: {
  view: DeployView;
  actions?: AttemptActions;
  onNavigate?: (path: string) => void;
}) {
  return (
    <Page width="reading">
      <Chrome view={view} onNavigate={onNavigate} />
      <Hero view={view} actions={actions} />

      {view.diagnosis ? (
        <DiagnosisPanel
          diagnosis={view.diagnosis}
          previousReleaseServing={view.previousReleaseServing}
          url={view.url}
        />
      ) : null}

      {/* On a faulty release, drift repeats the diagnosis, so it is hidden. */}
      {view.drift && view.faultyAt === undefined ? (
        <DriftPanel
          drift={view.drift}
          url={view.url}
          {...(actions.onRedeploy === undefined
            ? {}
            : { onRedeploy: actions.onRedeploy })}
          busy={actions.busy === 'redeploy'}
        />
      ) : null}

      <Provenance view={view} onNavigate={onNavigate} />

      {view.resources.length > 0 ? (
        <section className="flex flex-col gap-2">
          <Eyebrow>Resources on {view.target}</Eyebrow>
          <Card>
            <CardContent className="py-2">
              <Checklist items={view.resources} />
            </CardContent>
          </Card>
        </section>
      ) : null}

      <BuildDrawer view={view} />
      {view.id !== null ? <DeployDrawer view={view} /> : null}
    </Page>
  );
}

function Chrome({
  view,
  onNavigate,
}: {
  view: DeployView;
  onNavigate?: (path: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
      <p className="font-mono text-sm">
        {onNavigate ? (
          <button
            type="button"
            onClick={() => onNavigate(`/apps/${view.appId}`)}
            className="font-semibold hover:underline"
          >
            {view.app}
          </button>
        ) : (
          <span className="font-semibold">{view.app}</span>
        )}
        <span className="mx-1.5 text-muted-foreground">/</span>
        <span className="text-subtle">{view.component}</span>
        <span className="mx-1.5 text-muted-foreground">/</span>
        <span className="text-subtle">{attemptName(view)}</span>
      </p>
      <dl className="ml-auto flex flex-wrap gap-x-6 gap-y-1">
        <Meta label="Source" value={sourceRef(view.source)} />
        <Meta label="Target" value={view.target} />
        <Meta label="Build" value={<Builder view={view} />} />
      </dl>
    </div>
  );
}

/**
 * The build route with its platform. `Logo` is hidden from assistive
 * technology, so the platform is named in words too.
 */
function Builder({ view }: { view: DeployView }) {
  const build = view.build;
  // A supplied artifact: no builder ran.
  if (build === null) return <>none · extracted</>;

  const platform =
    build.runnerAdapter === null
      ? undefined
      : BUILD_ADAPTER[build.runnerAdapter];

  return (
    <span className="flex items-center gap-1.5">
      {platform ? <Logo name={platform.logo} className="size-3.5" /> : null}
      <span>
        {build.runner}
        {platform ? ` · ${platform.label}` : ''} · {build.fidelity}
      </span>
    </span>
  );
}

function attemptName(view: DeployView): string {
  return view.id === null ? `build ${view.buildId}` : `deploy ${view.id}`;
}

function sourceRef(source: SourceView): string {
  return source.kind === 'repo'
    ? shorten(source.commit)
    : `archive ${shorten(source.digest)}`;
}

/** A digest or commit, cut to the length a human compares by eye. */
function shorten(ref: string): string {
  const bare = ref.startsWith('sha256:') ? ref.slice('sha256:'.length) : ref;
  return bare.length > 12 ? bare.slice(0, 12) : bare;
}

function Meta({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="font-mono text-xs text-subtle">{value}</dd>
    </div>
  );
}

function Hero({
  view,
  actions,
}: {
  view: DeployView;
  actions: AttemptActions;
}) {
  const moving = isInFlight(view.phase);

  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <PhasePill phase={view.phase} faulty={view.faultyAt !== undefined}>
              {view.phaseWord}
            </PhasePill>
            {moving ? (
              <Eyebrow>
                <RunningTime since={view.at} active className="tabular-nums" />
              </Eyebrow>
            ) : (
              <Eyebrow>{view.when}</Eyebrow>
            )}
            {view.current ? <Eyebrow>· current release</Eyebrow> : null}
          </div>
          <h1 className="text-[27px] font-semibold leading-tight tracking-[-0.02em]">
            {view.headline}
          </h1>
          <Actions view={view} actions={actions} />
        </div>
        <UrlBlock view={view} />
      </div>
      <StageProgress
        stages={stagesOf(view)}
        className="border-t border-border-soft pt-4"
      />
    </Card>
  );
}

/**
 * The four legs of a release. Live is separate from Deploy because a failed
 * deploy leaves the previous release serving.
 */
function stagesOf(view: DeployView): readonly ProgressStage[] {
  const build = view.build;

  const deployStatus: StepStatus =
    view.id === null
      ? 'waiting'
      : view.phase === 'LIVE'
        ? 'done'
        : view.phase === 'FAILED'
          ? 'failed'
          : view.phase === 'PENDING'
            ? 'waiting'
            : 'running';

  return [
    // Always settled: the bytes were staged before any of this was written.
    {
      name: 'Source',
      status: 'done',
      detail: sourceRef(view.source),
    },
    build === null
      ? // A supplied artifact: nothing to build.
        { name: 'Build', status: 'done', detail: 'extracted' }
      : {
          name: 'Build',
          status: build.status,
          ...(build.duration === undefined ? {} : { detail: build.duration }),
        },
    {
      name: 'Deploy',
      status: deployStatus,
      // While moving, the usual duration from history stands in for progress.
      detail:
        view.id !== null && isInFlight(view.phase) && view.expectedDuration
          ? `usually about ${formatDuration(view.expectedDuration.p90Ms)}, from ${view.expectedDuration.samples} deploys`
          : view.target,
    },
    // Faulty: the release went live, then the platform reported it failed.
    view.faultyAt !== undefined
      ? { name: 'Live', status: 'failed', detail: 'faulty' }
      : view.urlLive
        ? { name: 'Live', status: 'done', detail: 'serving' }
        : view.previousReleaseServing
          ? // The App is up, on the previous release.
            { name: 'Live', status: 'waiting', detail: 'previous release' }
          : {
              name: 'Live',
              status: view.phase === 'FAILED' ? 'failed' : 'waiting',
            },
  ];
}

/**
 * Only the acts this attempt admits; an act that becomes possible later shows
 * disabled.
 */
function Actions({
  view,
  actions,
}: {
  view: DeployView;
  actions: AttemptActions;
}) {
  const {
    onRedeploy,
    onRollback,
    onDeployBuild,
    onCancel,
    onCancelDeploy,
    cancelRequested,
    busy,
  } = actions;
  const buttons = [];

  // Keyed on the artifact: a Build the supply chain refused is failed but still
  // has an image to place. A failed Build with no artifact gets Build again.
  const nothingToPlace =
    view.artifactDigest === null && view.build?.status === 'failed';

  if (view.id === null && onDeployBuild && !nothingToPlace) {
    const placeable = view.artifactDigest !== null;
    buttons.push(
      <Button
        key="deploy"
        size="sm"
        onClick={onDeployBuild}
        disabled={!placeable || (busy !== null && busy !== undefined)}
        // Disabled while the Build runs, so the next act stays visible.
        title={placeable ? undefined : 'Available once an artifact exists'}
      >
        <Rocket aria-hidden="true" className="size-3.5" />
        {busy === 'deploy' ? 'Deploying…' : 'Deploy this build'}
      </Button>,
    );
  }

  if (view.rollbackable && onRollback) {
    buttons.push(
      <Button
        key="rollback"
        size="sm"
        onClick={onRollback}
        disabled={busy !== null && busy !== undefined}
      >
        <Undo2 aria-hidden="true" className="size-3.5" />
        {busy === 'rollback' ? 'Rolling back…' : 'Roll back to this release'}
      </Button>,
    );
  }

  if (onRedeploy) {
    buttons.push(
      <Button
        key="redeploy"
        variant="outline"
        size="sm"
        onClick={onRedeploy}
        disabled={busy !== null && busy !== undefined}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn('size-3.5', busy === 'redeploy' && 'animate-spin')}
        />
        {busy === 'redeploy'
          ? view.build?.status === 'failed'
            ? 'Building…'
            : 'Redeploying…'
          : view.build?.status === 'failed'
            ? 'Build again'
            : 'Redeploy'}
      </Button>,
    );
  }

  // A running Build ends only when its route writes the verdict, so the button
  // stays pressed until then.
  if (
    onCancel &&
    (view.build?.status === 'waiting' || view.build?.status === 'running')
  ) {
    const requested =
      cancelRequested === true && view.build?.status === 'running';
    buttons.push(
      <Button
        key="cancel"
        variant="outline"
        size="sm"
        onClick={onCancel}
        disabled={requested || (busy !== null && busy !== undefined)}
        title={
          requested
            ? 'Cancel requested; the route reports the verdict'
            : undefined
        }
      >
        <Ban aria-hidden="true" className="size-3.5" />
        {requested || busy === 'cancel' ? 'Cancelling…' : 'Cancel build'}
      </Button>,
    );
  }

  // A requested cancel shows as pressed until the attempt honours it.
  if (onCancelDeploy && view.id !== null && isInFlight(view.phase)) {
    const requested = view.cancelRequestedBy !== undefined;
    buttons.push(
      <Button
        key="cancel-deploy"
        variant="outline"
        size="sm"
        onClick={onCancelDeploy}
        disabled={requested || (busy !== null && busy !== undefined)}
        title={
          requested
            ? `Cancel requested by ${view.cancelRequestedBy}`
            : undefined
        }
      >
        <Ban aria-hidden="true" className="size-3.5" />
        {requested || busy === 'cancel' ? 'Cancelling…' : 'Cancel deploy'}
      </Button>,
    );
  }

  if (buttons.length === 0) return null;
  return <div className="flex flex-wrap gap-2 self-start">{buttons}</div>;
}

/** Serving this attempt, serving the previous release, or reserved. */
function UrlBlock({ view }: { view: DeployView }) {
  const serving = view.urlLive;
  const previous = !serving && view.previousReleaseServing;

  // Latched, so a stream re-render mid-animation cannot undo it. Seeded from
  // the first render, so an attempt already live on first paint plays nothing.
  const wasServing = useRef(serving);
  const [arrived, setArrived] = useState(false);
  useEffect(() => {
    if (!wasServing.current && serving) setArrived(true);
    wasServing.current = serving;
  }, [serving]);

  return (
    <div className="ml-auto flex flex-col items-end gap-1 text-right">
      <Eyebrow>{serving || previous ? 'Serving' : 'Reserved'}</Eyebrow>
      <a
        href={normaliseUrl(view.url)}
        className={cn(
          'font-mono text-base',
          serving || previous
            ? 'border-b border-current text-accent-foreground'
            : 'pointer-events-none text-muted-foreground',
          arrived && 'motion-safe:animate-register',
        )}
      >
        {view.url}
      </a>
      {previous ? <Eyebrow>previous release</Eyebrow> : null}
    </div>
  );
}

function Provenance({
  view,
  onNavigate,
}: {
  view: DeployView;
  onNavigate?: (path: string) => void;
}) {
  const source = view.source;

  return (
    <section className="flex flex-col gap-2">
      <Eyebrow>What this {view.id === null ? 'build' : 'release'} is</Eyebrow>
      <Card>
        <CardContent className="grid gap-x-6 gap-y-3 py-3 sm:grid-cols-2">
          {source.kind === 'repo' ? (
            <>
              <Fact label="Repository" value={source.repo} />
              <Fact
                label="Commit"
                value={source.commit}
                note={source.commitMessage ?? undefined}
                copy
              />
              {source.commitAuthor ? (
                <Fact
                  label="Author"
                  value={source.commitAuthor}
                  note={source.commitAuthoredAt ?? undefined}
                />
              ) : null}
            </>
          ) : (
            <>
              <Fact
                label="Uploaded archive"
                value={source.digest}
                note={
                  source.extracted
                    ? 'finished output — recorded as-is, never built'
                    : 'source — built through the same pipeline as a repo'
                }
              />
              <Fact label="Bundle location" value={source.location} />
            </>
          )}
          <Fact label="Scope" value={source.subpath} />
          <Fact label="Artifact" value={view.artifactDigest} copy />
          <Fact label="Config version" value={view.configVersion} copy />
          <Fact label="Created" value={view.at} />
          {/* A Build with no Deploy has no requester; an older Deploy shows a dash. */}
          {view.id === null ? null : (
            <Fact label="Requested by" value={view.requestedBy ?? null} />
          )}
        </CardContent>
      </Card>
      {view.previousDeployId !== null && onNavigate ? (
        <button
          type="button"
          onClick={() => onNavigate(`/deploys/${view.previousDeployId}`)}
          className="flex items-center gap-1.5 self-start text-xs text-subtle hover:text-foreground"
        >
          <ArrowLeft aria-hidden="true" className="size-3.5" />
          Deploy {view.previousDeployId} — the release before this one
        </button>
      ) : null}
    </section>
  );
}

/** A dash stands for a value that was never recorded. */
function Fact({
  label,
  value,
  note,
  copy = false,
}: {
  label: string;
  value: string | null;
  note?: string;
  copy?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Eyebrow>{label}</Eyebrow>
      <span className="flex min-w-0 items-center gap-1">
        <span
          className={cn(
            'truncate font-mono text-xs',
            value === null ? 'text-muted-foreground' : 'text-subtle',
          )}
          title={value ?? undefined}
        >
          {value ?? '—'}
        </span>
        {copy && value !== null ? (
          <CopyButton value={value} label={label.toLowerCase()} />
        ) : null}
      </span>
      {note ? (
        <span className="text-[11px] text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}

/**
 * Open while the build runs or after it fails. Keyed on the build's status,
 * since a deploy can fail on a good build; a status change resets it.
 */
function BuildDrawer({ view }: { view: DeployView }) {
  const build = view.build;
  const autoOpen = build?.status === 'failed' || build?.status === 'running';
  const [open, setOpen] = useState(autoOpen);
  const priorStatus = useRef(build?.status ?? null);

  useEffect(() => {
    const status = build?.status ?? null;
    if (priorStatus.current === status) return;
    priorStatus.current = status;
    setOpen(status !== null && status !== 'done');
  }, [build?.status]);

  // A supplied artifact: no build ran, so a notice replaces the log pane.
  if (build === null) {
    return (
      <Notice label="NO BUILD">
        This release delivers uploaded output, digested over the bundle exactly
        as it arrived. No builder was involved, so there is no build log.
      </Notice>
    );
  }

  return (
    <Stage
      ordinal="1"
      name="Build"
      status={build.status}
      word={statusWord(build.status)}
      note={build.duration ?? null}
      open={open}
      onOpenChange={setOpen}
    >
      <Checklist items={build.steps} />
      <BuildOutput view={view} />
    </Stage>
  );
}

/**
 * One numbered pipeline leg. Build and Deploy render as peers, because either
 * can fail while the other is fine.
 */
function Stage({
  ordinal,
  name,
  status,
  word,
  note,
  open,
  onOpenChange,
  children,
}: {
  ordinal: string;
  name: string;
  status: 'done' | 'running' | 'failed' | 'waiting';
  word: string;
  note: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} asChild>
      <Card>
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-[0.07em] text-subtle hover:text-foreground">
          <span className="font-mono text-[11px] text-muted-foreground">
            {ordinal}
          </span>
          <StepGlyph status={status} />
          <span className="text-foreground">{name}</span>
          <span>· {word}</span>
          {note ? (
            <span className="text-muted-foreground">· {note}</span>
          ) : null}
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'ml-auto size-4 transition-transform',
              open && 'rotate-90',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-3.5 pb-3.5">{children}</div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/**
 * The build log, or a notice when the runner withholds text until it finishes,
 * with a link to the runner's own page when it reports one.
 */
function BuildOutput({ view }: { view: DeployView }) {
  const build = view.build;
  if (build === null) return null;
  if (build.log !== null) {
    return <Transcript build={build} buildId={view.buildId} />;
  }

  if (build.fidelity === 'LIVE_STATUS') {
    return (
      <Notice label="LIVE_STATUS">
        {build.runner} reports step status live, but its log text only arrives
        when the build finishes. The checklist above is the live view
        {build.runUrl === null ? (
          '.'
        ) : (
          <>
            {' — '}
            <RunLink url={build.runUrl} inline />
            {' for the text as it is written.'}
          </>
        )}
      </Notice>
    );
  }

  return (
    <Notice label={build.fidelity}>
      {build.runner} releases its log when the build finishes.
      {build.runUrl === null ? null : (
        <>
          {' '}
          <RunLink url={build.runUrl} inline />
          {' to watch it there.'}
        </>
      )}
    </Notice>
  );
}

/**
 * The runner's log tail, open only on a failed build. A `LIVE_TEXT` runner
 * sends text while running, so a status change re-derives `open`.
 */
function Transcript({
  build,
  buildId,
}: {
  build: NonNullable<DeployView['build']>;
  buildId: number;
}) {
  const lines = build.log ?? [];
  const [open, setOpen] = useState(build.status === 'failed');
  const priorStatus = useRef(build.status);

  useEffect(() => {
    if (priorStatus.current === build.status) return;
    priorStatus.current = build.status;
    setOpen(build.status === 'failed');
  }, [build.status]);

  const clipped = build.logTotal > lines.length;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col">
      <CollapsibleTrigger className="flex items-center gap-2 self-start text-[12.5px] text-subtle hover:text-foreground">
        <ChevronRight
          aria-hidden="true"
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        {open ? 'Hide' : 'Show'} {build.runner} output
        <span className="text-muted-foreground">
          {clipped
            ? `· last ${lines.length} of ${build.logTotal} lines`
            : `· ${build.logTotal} lines`}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="flex flex-col gap-2 pt-2">
          <LogPane lines={lines} follow={build.status === 'running'} />
          {clipped ? (
            <p className="text-[11.5px] text-muted-foreground">
              Only the tail is kept here — a failure is at the end of a log, and
              the full transcript stays on the runner.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-4">
            <PlainTextLink buildId={buildId} />
            <RunLink url={build.runUrl} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The attempt log as plain text: both legs with a `deployId`, the build's
 * without. The browser sends the session cookie itself.
 */
function PlainTextLink({
  buildId,
  deployId,
}: {
  buildId: number;
  deployId?: number;
}) {
  const query = new URLSearchParams({ buildId: String(buildId) });
  if (deployId !== undefined) query.set('deployId', String(deployId));
  return (
    <a
      href={`${ATTEMPT_LOG_TEXT_PATH}?${query}`}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1 self-start text-[12.5px] font-medium text-accent-foreground hover:underline"
    >
      <FileText aria-hidden className="size-3" />
      Plain text
    </a>
  );
}

/** Only from a URL the backend reported, never one composed from a run id. */
function RunLink({ url, inline }: { url: string | null; inline?: boolean }) {
  if (url === null) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className={cn(
        'inline-flex items-center gap-1 font-medium text-accent-foreground hover:underline',
        inline ? '' : 'self-start text-[12.5px]',
      )}
    >
      Open the run
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** The deploy leg, which reads only its own phase whatever the Build did. */
function DeployDrawer({ view }: { view: DeployView }) {
  const autoOpen = view.phase !== 'LIVE';
  const [open, setOpen] = useState(autoOpen);
  const priorPhase = useRef(view.phase);

  useEffect(() => {
    if (priorPhase.current === view.phase) return;
    priorPhase.current = view.phase;
    setOpen(view.phase !== 'LIVE');
  }, [view.phase]);

  return (
    <Stage
      ordinal="2"
      name="Deploy"
      status={
        view.phase === 'LIVE'
          ? 'done'
          : view.phase === 'FAILED'
            ? 'failed'
            : 'running'
      }
      word={view.phase.toLowerCase()}
      note={view.target}
      open={open}
      onOpenChange={setOpen}
    >
      {view.deployLog === null ? (
        <Notice label="LIVE_STATUS">
          The controller reports deploy status live; no text line has arrived
          yet.
        </Notice>
      ) : (
        <>
          <LogPane lines={view.deployLog} follow={isInFlight(view.phase)} />
          <PlainTextLink
            buildId={view.buildId}
            deployId={view.id ?? undefined}
          />
        </>
      )}
    </Stage>
  );
}

/**
 * Whether this attempt just reached LIVE. `previous` is undefined until the tab
 * has seen a phase, so an attempt already live on load never counts.
 */
export function enteredLive(
  previous: DeployPhase | undefined,
  next: DeployPhase,
): boolean {
  return previous !== undefined && previous !== 'LIVE' && next === 'LIVE';
}

/** One Deploy, re-read on each attempt stream event instead of on a timer. */
export function DeployScreen({
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

  const [busy, setBusy] = useState<'redeploy' | 'rollback' | 'cancel' | null>(
    null,
  );
  const [reloadToken, setReloadToken] = useState(0);
  // Seeded by the first read, so a deploy LIVE on open never flies over.
  const priorPhase = useRef<DeployPhase | undefined>(undefined);

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
          priorPhase.current = result.value.deploy.phase;
          stopStream = subscribeAttempt(
            {
              buildId: result.value.deploy.buildId,
              // Never null: `getDeployDetail` always answers about a Deploy.
              deployId: result.value.deploy.id ?? parsedId,
            },
            () => {
              void command('getDeployDetail', { id: parsedId }).then(
                (fresh) => {
                  if (live && fresh.ok) {
                    if (
                      enteredLive(priorPhase.current, fresh.value.deploy.phase)
                    ) {
                      flyover();
                    }
                    priorPhase.current = fresh.value.deploy.phase;
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
      // The App's id, since two Apps can share a name.
      const result = await command('deployApp', { name: state.deploy.appId });
      if (result.ok) {
        onNavigate(
          result.value.deployId === null
            ? `/builds/${result.value.buildId}`
            : `/deploys/${result.value.deployId}`,
        );
      } else {
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
      const result = await command('rollbackDeploy', {
        componentId: view.componentId,
        targetId: view.targetId,
        buildId: view.buildId,
      });
      if (result.ok) {
        notify({
          tone: 'success',
          title: `Rolled back to build ${view.buildId}`,
          detail: `Deploy #${result.value.deployId} is the release now serving.`,
        });
        onNavigate(`/deploys/${result.value.deployId}`);
      } else {
        notify({
          tone: 'destructive',
          title: 'Rollback refused',
          detail: result.failure.message,
        });
      }
    } catch (cause: unknown) {
      notify({
        tone: 'destructive',
        title: 'Rollback refused',
        detail: cause instanceof Error ? cause.message : 'Rollback failed',
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Re-reads instead of navigating: a queued Deploy fails at once, and one in
   * flight comes back still moving, with the request on it.
   */
  const handleCancel = async () => {
    if (state.type !== 'success' || state.deploy.id === null) return;
    setBusy('cancel');
    try {
      const result = await command('cancelDeploy', { id: state.deploy.id });
      if (result.ok) {
        setReloadToken((token) => token + 1);
      } else {
        notify({
          tone: 'destructive',
          title: 'Cancel refused',
          detail: result.failure.message,
        });
      }
    } catch (cause: unknown) {
      notify({
        tone: 'destructive',
        title: 'Cancel failed',
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
    <DeployDetail
      view={state.deploy}
      actions={{
        onRedeploy: handleRedeploy,
        onRollback: handleRollback,
        onCancelDeploy: () => void handleCancel(),
        busy,
      }}
      onNavigate={onNavigate}
    />
  );
}

/** One Build, which links to its related Deploy once placed. */
export function BuildScreen({
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
  const [busy, setBusy] = useState<'redeploy' | 'deploy' | 'cancel' | null>(
    null,
  );
  const [cancelRequested, setCancelRequested] = useState(false);
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
      // A cancel request lasts only for the run it was made on.
      if (result.value.attempt.build?.status !== 'running') {
        setCancelRequested(false);
      }
    };

    read()
      .then(() => {
        if (!live) return;
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
    const verb =
      kind === 'deploy'
        ? 'Deploy'
        : state.attempt.build?.status === 'failed'
          ? 'Build'
          : 'Redeploy';
    setBusy(kind);
    try {
      // `deployApp` places the App's newest artifact, or starts a Build when
      // there is none.
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
          title: `${verb} refused`,
          detail: result.failure.message,
        });
      }
    } catch (cause) {
      notify({
        tone: 'destructive',
        title: `${verb} failed`,
        detail: cause instanceof Error ? cause.message : 'Server failure',
      });
    } finally {
      setBusy(null);
    }
  };

  /**
   * Re-reads instead of navigating. A running Build's verdict arrives a poll
   * later, from the route that was stopped.
   */
  const cancel = async () => {
    const parsedId = Number.parseInt(buildId, 10);
    setBusy('cancel');
    try {
      const result = await command('cancelBuild', { id: parsedId });
      if (result.ok) {
        if (result.value.status === 'RUNNING') setCancelRequested(true);
        setReloadToken((token) => token + 1);
      } else {
        notify({
          tone: 'destructive',
          title: 'Cancel refused',
          detail: result.failure.message,
        });
      }
    } catch (cause) {
      notify({
        tone: 'destructive',
        title: 'Cancel failed',
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
          onCancel: () => void cancel(),
          cancelRequested,
          busy,
        }}
        onNavigate={onNavigate}
      />
    </>
  );
}
