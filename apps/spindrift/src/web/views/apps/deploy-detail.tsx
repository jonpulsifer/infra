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
import {
  ArrowLeft,
  ChevronRight,
  ExternalLink,
  RefreshCw,
  Rocket,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
/**
 * The mark and the name for a build route's platform.
 *
 * The same shape `targets/list.tsx` uses for a Target's adapter, and here for
 * the same reason: an installation names its own routes ("hosted", "cloud"),
 * so the route's *name* identifies nothing to somebody who did not configure
 * it. The adapter does, and it is a closed vocabulary
 * (`manifest.schema.ts`'s `buildRouteAdapterSchema`).
 *
 * `in-cluster` gets the Kubernetes mark because that is literally where it
 * runs — §4's build Job — not because the App is going to Kubernetes.
 *
 * Keyed by a `string` rather than the enum, so a route this build grew and
 * this table has not is a missing key rather than a crash: the runner's name
 * is still rendered, only unaccompanied.
 */
import type { LogoName } from '../../client/logos/index.ts';
import { Checklist } from '../../components/checklist.tsx';
import { DiagnosisPanel, DriftPanel } from '../../components/diagnosis.tsx';
import { LogPane, Notice } from '../../components/log-pane.tsx';
import {
  type Stage as ProgressStage,
  StageProgress,
} from '../../components/progress.tsx';
import { RunningTime } from '../../components/running-time.tsx';
import { PhasePill, StepGlyph, statusWord } from '../../components/status.tsx';
import {
  type DeployView,
  isInFlight,
  type SourceView,
  type StepStatus,
} from '../../model.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { Logo } from '../../ui/logo.tsx';
import { cn, normaliseUrl } from '../../ui/utils.ts';

const BUILD_ADAPTER: Record<string, { logo: LogoName; label: string }> = {
  'github-actions': { logo: 'github', label: 'GitHub Actions' },
  'cloud-build': { logo: 'google-cloud', label: 'Cloud Build' },
  'in-cluster': { logo: 'kubernetes', label: 'in-cluster' },
};

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

      {/*
        Below the diagnosis, and never instead of it. The two can both be
        absent, and only drift can be present on a green release — but a red
        release that has also drifted leads with why it failed, because that is
        the older and more actionable fact.
      */}
      {view.drift ? (
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
      {/*
        Every release has a deploy leg, so every release gets the drawer. It
        used to be gated on a green build, which hid the log on precisely the
        screen that needed it: a Deploy over a Build the supply chain refused
        is red *at the deploy*, and gating on the build meant the only thing on
        screen was a build log, saying the failure was somewhere it was not.
        A Build with no intent (`id === null`) still has no deploy leg — that
        one is an absence, not a hidden pane.
      */}
      {view.id !== null ? <DeployDrawer view={view} /> : null}
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
        <Meta label="Build" value={<Builder view={view} />} />
      </dl>
    </div>
  );
}

/**
 * Which builder ran this build — the platform, not just the route's name.
 *
 * "Building on hosted" names one installation's route and leaves an operator
 * unable to tell GitHub Actions from Cloud Build, which is the fact that
 * decides where to go look: the two fail in different places, over different
 * credentials, with different things to read. So the route name stays (it is
 * what an operator configured and what the manifest calls it) and the platform
 * is stated beside it, with its mark, exactly as a Target or a repository
 * identifies its platform.
 *
 * The mark is decorative — `Logo` hides it from assistive technology — so the
 * platform is named in words as well. A logo that is the only carrier of a fact
 * is a fact a screen reader never reads out.
 */
function Builder({ view }: { view: DeployView }) {
  const build = view.build;
  // §4's supplied artifact: no builder ran, so there is no platform to name.
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
  const moving = isInFlight(view.phase);

  return (
    <Card className="flex flex-col gap-4 px-5 py-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <PhasePill phase={view.phase}>{view.phaseWord}</PhasePill>
            {/*
              While it is moving, the number that matters is how long it has
              been moving — a screen whose only time reads "just now" for the
              first minute of a rollout looks frozen. Once it settles, "8m ago"
              is the right grain again and the timer goes away rather than
              standing there having stopped.
            */}
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
 * The four legs every release has, in the order they happen.
 *
 * They are derived here rather than carried on {@link DeployView} because none
 * of them is a new fact: each one is a projection of state the read model
 * already states, and a fifth field restating them is a fifth field that can
 * disagree with the four it was derived from.
 *
 * **Live is its own leg, and not a duplicate of Deploy.** The two answer
 * different questions on the case that matters most: §9 never mutates exposure
 * on red, so a failed deploy leaves the previous release serving — Deploy is
 * `failed` and the App is still up. Collapsing them would make the strip say
 * the App is down when it is not, which is the single most frightening thing a
 * screen can get wrong.
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
      ? // §4's supplied artifact — finished output, recorded as-is. Green
        // because nothing is owed, and labelled so it does not read as a build
        // that quietly succeeded.
        { name: 'Build', status: 'done', detail: 'extracted' }
      : {
          name: 'Build',
          status: build.status,
          ...(build.duration === undefined ? {} : { detail: build.duration }),
        },
    { name: 'Deploy', status: deployStatus, detail: view.target },
    view.urlLive
      ? { name: 'Live', status: 'done', detail: 'serving' }
      : view.previousReleaseServing
        ? // Serving, just not this release. Neither green nor red: the App is
          // up and this attempt did not put it there.
          { name: 'Live', status: 'waiting', detail: 'previous release' }
        : {
            name: 'Live',
            status: view.phase === 'FAILED' ? 'failed' : 'waiting',
          },
  ];
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

  // An artifact that exists is deployable, and the button keys on the artifact
  // rather than on the Build's status. Those two disagree on the case that
  // matters: a Build the supply chain refused is FAILED with an image in the
  // registry, and hiding the act there says the artifact cannot be placed when
  // it can. Only a Build that ended having produced nothing has nothing to
  // offer — and that one gets Rebuild, below.
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
        // A Build still running has nothing to place yet. It is shown disabled
        // rather than hidden so the next act is visible while you wait for it.
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
 * release before it, or reserved with nothing behind it yet.
 *
 * §21 wants an App to carry a lowest-precedence wildcard route from the
 * moment it exists, so a reserved name resolves to a status page instead of a
 * dead one — but that route is not built (see the README's "status page is
 * not served yet"), so the third case names only the state, not a page.
 */
function UrlBlock({ view }: { view: DeployView }) {
  const serving = view.urlLive;
  const previous = !serving && view.previousReleaseServing;

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
        )}
      >
        {view.url}
      </a>
      {previous ? <Eyebrow>previous release</Eyebrow> : null}
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
 * One leg of the pipeline, as a card that looks exactly like the other one.
 *
 * Build and Deploy are **two stages, not one story with a tail**: a Build
 * records an artifact, a Deploy places one, and either can go red while the
 * other is fine. The screen has to be able to say that, and it can only say it
 * if the two read as peers — same header, same glyph, its own verdict on each.
 * A layout that made Deploy a section *inside* Build could not express "the
 * image is fine, the placement failed", which is the most common red there is.
 *
 * The ordinal is what makes the pairing legible at a glance: two numbered
 * stages, and the reader can see which one stopped.
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
 * §4's `logFidelity`, stated rather than worked around.
 *
 * A runner that reports step status live but only releases text on completion
 * leaves the checklist above as the only live view. §18 makes saying so
 * mandatory — the alternative renders an empty pane and a spinner, which reads
 * as a broken stream rather than a known limit of that runner.
 *
 * **Stating the limit is necessary but not sufficient**: the text exists, it is
 * live, and it is simply somewhere Spindrift cannot read from yet. So where the
 * runner reports a page of its own, the sentence carries a way to go read it
 * instead of only apologising for not having it.
 */
function BuildOutput({ view }: { view: DeployView }) {
  const build = view.build;
  if (build === null) return null;
  if (build.log !== null) {
    return <Transcript build={build} />;
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
 * The runner's raw text, behind one more click and never the whole of it.
 *
 * The checkpoints above are the build. This is the evidence for them, and a
 * drawer that opened straight onto a thousand lines of BuildKit chatter buried
 * the seven lines that said what happened. So it stays shut on green — nobody
 * reads a successful build's transcript — and springs open on red, where the
 * last lines are the answer.
 *
 * `logTotal` is stated whenever it exceeds what is here. A tail presented as
 * the log is the UI editing evidence; a tail that says how much it is a tail
 * of, and where the rest lives, is not.
 *
 * The initial `open` is only half the contract — a `LIVE_TEXT` runner (§4)
 * releases text as it's written, so `BuildOutput` can hand this a non-null
 * `log` while the build is still `running`, well before red is known at
 * mount. Without re-deriving `open` on a status change, React keeps whatever
 * it picked at that early mount forever, and a running→failed transition
 * lands on a drawer that never sprang open. Same shape as `BuildDrawer`'s
 * prior-status effect above, for the same reason.
 */
function Transcript({ build }: { build: NonNullable<DeployView['build']> }) {
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
          <RunLink url={build.runUrl} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * A way out to the runner's own view of this run.
 *
 * Rendered only from a URL the backend reported. Nothing here composes one out
 * of a run id and a host name: a guessed link that 404s is worse than no link,
 * because it is offered at the moment the reader has already been told the log
 * is elsewhere.
 */
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

/**
 * The deploy leg — stage 2, and never a consequence of stage 1.
 *
 * It reads its own phase and nothing else. The Build above it may be green,
 * red, or still going; what this stage says is what the platform said when the
 * artifact was placed. That independence is the point: an artifact that exists
 * is deployable to any supported Target, so a red Build is a fact about an
 * older artifact and not a reason to stop describing this placement.
 */
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
        <LogPane lines={view.deployLog} follow={isInFlight(view.phase)} />
      )}
    </Stage>
  );
}
