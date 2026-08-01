/**
 * The attempt screen (Task 39, §18).
 *
 * **App-first, not attempt-first.** The order down the page is state and URL,
 * then diagnosis, then what this release *is*, then resources, then the logs —
 * and that order is the whole design. §18 rejects the stage rail every CI tool
 * reaches for, because here the running App is the product and the pipeline is
 * only how it got there. A rail puts the pipeline first and makes a green
 * deploy a screen about a build.
 *
 * **A release has a source, and only sometimes a build.** §4: "Repo and archive
 * share one pipeline — unpack, detect, build. An archive of *finished output* is
 * a supplied artifact, digested over the uploaded bundle." That release was
 * extracted, never built, and `uploadArchive` records it with a null runner
 * because "saying so is more useful than naming a runner that never ran". So
 * Source is a section that is always there and Build is a drawer that is not.
 *
 * **The same screen renders a Build with no Deploy.** Pressing Deploy on an App
 * with nothing deployable starts a Build and writes no intent (§4, §6), and that
 * press still has to land somewhere. `view.id === null` is that state: same
 * identity, same source, same log, no release — and the actions change to match.
 *
 * Four rules this file implements literally, each from §18:
 *
 * - **The log collapses on green and auto-opens on red or running.** A finished
 *   green build is the one case nobody reads the log for.
 * - **The live checklist is labelled as the live view** when the runner reports
 *   step status but withholds text (§4's `LIVE_STATUS`). That one line is
 *   load-bearing: without it the screen looks broken rather than honest.
 * - **`blame` earns its chip**, in the diagnosis block.
 * - **The red screen says the previous release is still serving.**
 *
 * No framework means owning navigation and streaming by hand. The screen still
 * takes one immutable view; its controller replaces that view as authenticated
 * attempt events arrive.
 */
import { ArrowLeft, RefreshCw, Rocket, Undo2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Checklist } from '../../components/checklist.tsx';
import { DiagnosisPanel } from '../../components/diagnosis.tsx';
import { LogPane, Notice } from '../../components/log-pane.tsx';
import { PhasePill, StepGlyph, statusWord } from '../../components/status.tsx';
import type { DeployView, SourceView } from '../../model.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { cn } from '../../ui/utils.ts';

/**
 * What the operator can do from here, and which one is running.
 *
 * One object rather than three pairs of props: the actions are mutually
 * exclusive in practice — a release is either current, older, or not a release
 * yet — and `busy` naming which one is in flight keeps two buttons from both
 * claiming to be working.
 */
export interface AttemptActions {
  /** Deploy the App's newest artifact again, or rebuild it if there is none. */
  readonly onRedeploy?: () => void;
  /** Make this older release live again (§6: an ordinary deploy). */
  readonly onRollback?: () => void;
  /** Place the artifact this finished Build produced. */
  readonly onDeployBuild?: () => void;
  readonly busy?: 'redeploy' | 'rollback' | 'deploy' | null;
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
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-5 py-6">
      <Chrome view={view} onNavigate={onNavigate} />
      <Hero view={view} actions={actions} />

      {view.diagnosis ? (
        <DiagnosisPanel
          diagnosis={view.diagnosis}
          previousReleaseServing={view.previousReleaseServing}
          url={view.url}
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
      {view.id !== null && view.build?.status === 'done' ? (
        <DeployDrawer view={view} />
      ) : null}
    </div>
  );
}

/**
 * What this attempt is, in one line: which Component, from which source, on
 * which Target, built by which runner — if one ran.
 *
 * It sits above the state rather than inside it because it is the same for
 * every phase — identity, not status. The runner carries its `logFidelity`
 * because that is the fact explaining why the log below may be silent (§4).
 */
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
        <Meta
          label="Build"
          value={
            view.build === null
              ? 'none · extracted'
              : `${view.build.runner} · ${view.build.fidelity}`
          }
        />
      </dl>
    </div>
  );
}

/** What to call this attempt: a release has a number, a Build has its own. */
function attemptName(view: DeployView): string {
  return view.id === null ? `build ${view.buildId}` : `deploy ${view.id}`;
}

/** The short form of a source, for a one-line header. */
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

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="font-mono text-xs text-subtle">{value}</dd>
    </div>
  );
}

/**
 * State and URL, side by side and above everything else.
 *
 * The URL is the answer to the only question a developer opens this screen
 * with, so it is never further down than the phase that describes it.
 */
function Hero({
  view,
  actions,
}: {
  view: DeployView;
  actions: AttemptActions;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-4 px-5 py-5">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <PhasePill phase={view.phase}>{view.phaseWord}</PhasePill>
          <Eyebrow>{view.when}</Eyebrow>
          {view.current ? <Eyebrow>· current release</Eyebrow> : null}
        </div>
        <h1 className="text-[27px] font-semibold leading-tight tracking-[-0.02em]">
          {view.headline}
        </h1>
        <Actions view={view} actions={actions} />
      </div>
      <UrlBlock view={view} />
    </Card>
  );
}

/**
 * The acts this attempt admits, and no others.
 *
 * The branching is the point. A Build that finished is deployable and is not
 * redeployable, because there is no release to repeat; an older release is
 * rollable-back and a current one is not, because §6 refuses a "rollback" to
 * something that is not older. Rendering every button always and letting the
 * command refuse would teach the operator that half the buttons lie.
 */
function Actions({
  view,
  actions,
}: {
  view: DeployView;
  actions: AttemptActions;
}) {
  const { onRedeploy, onRollback, onDeployBuild, busy } = actions;
  const buttons = [];

  if (view.id === null && onDeployBuild && view.build?.status !== 'failed') {
    buttons.push(
      <Button
        key="deploy"
        size="sm"
        onClick={onDeployBuild}
        disabled={busy !== null && busy !== undefined}
        // A Build still running has nothing to place yet. It is shown disabled
        // rather than hidden so the next act is visible while you wait for it.
        title={
          view.build !== null && view.build.status !== 'done'
            ? 'Available once the build finishes'
            : undefined
        }
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
          ? 'Working…'
          : view.build?.status === 'failed'
            ? 'Build again'
            : 'Redeploy'}
      </Button>,
    );
  }

  if (buttons.length === 0) return null;
  return <div className="flex flex-wrap gap-2 self-start">{buttons}</div>;
}

/**
 * The three honest things a name can be: serving this attempt, serving the
 * release before it, or reserved and answering with a status page.
 *
 * §21 gives an App a lowest-precedence wildcard route from the moment it
 * exists, so the third case is a real page rather than a dead name — which is
 * why it is labelled "status page" and not "not yet available".
 */
function UrlBlock({ view }: { view: DeployView }) {
  const serving = view.urlLive;
  const previous = !serving && view.previousReleaseServing;

  return (
    <div className="ml-auto flex flex-col items-end gap-1 text-right">
      <Eyebrow>{serving || previous ? 'Serving' : 'Reserved'}</Eyebrow>
      <a
        href={`https://${view.url}`}
        className={cn(
          'font-mono text-base',
          serving || previous
            ? 'border-b border-current text-accent-foreground'
            : 'pointer-events-none text-muted-foreground',
        )}
      >
        {view.url}
      </a>
      {previous ? <Eyebrow>previous release</Eyebrow> : null}
      {!serving && !previous ? <Eyebrow>status page</Eyebrow> : null}
    </div>
  );
}

/**
 * What this release is made of, and what it pinned.
 *
 * A Deploy row is written once and never edited into a different release: its
 * Build, its source, and the config document it captured (§10) are what it
 * delivered, which is what makes "roll back to this" a reproducible act rather
 * than a hopeful one. This section is where those facts are legible — and where
 * §10's version hash appears, because a release whose config you cannot name is
 * one you cannot claim to be able to reproduce.
 */
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
              <Fact label="Commit" value={source.commit} />
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
          <Fact label="Artifact" value={view.artifactDigest} />
          <Fact label="Config version" value={view.configVersion} />
          <Fact label="Created" value={view.at} />
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

/**
 * One recorded fact, or the statement that it was never recorded.
 *
 * The em dash is not a placeholder for a value that is loading. §10 pins config
 * on the Deploy row when the intent is written, so a release with no version
 * is one that pinned nothing — and "—" says that, where an empty cell would
 * read as a rendering bug.
 */
function Fact({
  label,
  value,
  note,
}: {
  label: string;
  value: string | null;
  note?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Eyebrow>{label}</Eyebrow>
      <span
        className={cn(
          'truncate font-mono text-xs',
          value === null ? 'text-muted-foreground' : 'text-subtle',
        )}
        title={value ?? undefined}
      >
        {value ?? '—'}
      </span>
      {note ? (
        <span className="text-[11px] text-muted-foreground">{note}</span>
      ) : null}
    </div>
  );
}

/**
 * The build, collapsed on green — and absent entirely when none ran.
 *
 * §18's "auto-opens on red or running" keys on **the build's** status, not on
 * the screen's. The distinction is load-bearing on exactly the case that
 * justifies the blame chip: an `ARTIFACT_UNAVAILABLE` deploy is red with a
 * green build, and springing the build log open there would contradict the
 * chip three lines above it that exists to say the build is fine. So a failed
 * deploy on a good build leaves this shut and sends the reader to the
 * diagnosis, which is the thing that knows something.
 *
 * Open-ness starts from that status and stays under the reader's control
 * after that — which is the reason `ui/collapsible.tsx` wraps Radix instead of
 * using `<details>`: the initial value is derived from state that arrives with
 * the data, and React cannot take back an uncontrolled `open`.
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

  // §4's supplied artifact: nothing ran, so there is no drawer to open. The
  // sentence replaces it rather than an empty log pane, which would read as a
  // build whose output went missing.
  if (build === null) {
    return (
      <Notice label="NO BUILD">
        This release delivers uploaded output, digested over the bundle exactly
        as it arrived. No builder was involved, so there is no build log.
      </Notice>
    );
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-[0.07em] text-subtle hover:text-foreground">
          <StepGlyph status={build.status} />
          Build log · {statusWord(build.status)}
          {build.duration ? ` · ${build.duration}` : ''}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-3.5 pb-3.5">
            <Checklist items={build.steps} />
            <BuildOutput view={view} />
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

/**
 * §4's `logFidelity`, stated rather than worked around.
 *
 * A runner that reports step status live but only releases text on completion
 * leaves the checklist above as the only live view. §18 makes saying so
 * mandatory — the alternative renders an empty pane and a spinner, which reads
 * as a broken stream rather than a known limit of that runner.
 */
function BuildOutput({ view }: { view: DeployView }) {
  const build = view.build;
  if (build === null) return null;
  if (build.log !== null) return <LogPane lines={build.log} />;

  if (build.fidelity === 'LIVE_STATUS') {
    return (
      <Notice label="LIVE_STATUS">
        {build.runner} reports step status live, but its log text only arrives
        when the build finishes. The checklist above is the live view.
      </Notice>
    );
  }

  return (
    <Notice label={build.fidelity}>
      {build.runner} releases its log when the build finishes.
    </Notice>
  );
}

/** The deploy leg is separate from build output and opens on deploy red. */
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
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-[0.07em] text-subtle hover:text-foreground">
          <StepGlyph
            status={
              view.phase === 'LIVE'
                ? 'done'
                : view.phase === 'FAILED'
                  ? 'failed'
                  : 'running'
            }
          />
          Deploy log · {view.phase.toLowerCase()}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-3.5 pb-3.5">
            {view.deployLog === null ? (
              <Notice label="LIVE_STATUS">
                The controller reports deploy status live; no text line has
                arrived yet.
              </Notice>
            ) : (
              <LogPane lines={view.deployLog} />
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
