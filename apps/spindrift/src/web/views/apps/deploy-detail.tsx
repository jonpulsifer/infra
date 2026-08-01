/**
 * The deploy screen (Task 39, §18).
 *
 * **App-first, not attempt-first.** The order down the page is state and URL,
 * then diagnosis, then resources, then the log — and that order is the whole
 * design. §18 rejects the stage rail every CI tool reaches for, because here
 * the running App is the product and the pipeline is only how it got there. A
 * rail puts the pipeline first and makes a green deploy a screen about a build.
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
import { RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Checklist } from '../../components/checklist.tsx';
import { DiagnosisPanel } from '../../components/diagnosis.tsx';
import { LogPane, Notice } from '../../components/log-pane.tsx';
import { PhasePill, StepGlyph, statusWord } from '../../components/status.tsx';
import type { DeployView } from '../../model.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '../../ui/collapsible.tsx';
import { cn } from '../../ui/utils.ts';

export function DeployDetail({
  view,
  onRedeploy,
  redeploying = false,
  onNavigate,
}: {
  view: DeployView;
  onRedeploy?: () => void;
  redeploying?: boolean;
  onNavigate?: (path: string) => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-4 px-5 py-6">
      <Chrome view={view} onNavigate={onNavigate} />
      <Hero
        view={view}
        onRedeploy={onRedeploy}
        redeploying={redeploying}
      />

      {view.diagnosis ? (
        <DiagnosisPanel
          diagnosis={view.diagnosis}
          previousReleaseServing={view.previousReleaseServing}
          url={view.url}
        />
      ) : null}

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
      {view.build.status === 'done' ? <DeployDrawer view={view} /> : null}
    </div>
  );
}

/**
 * What this attempt is, in one line: which Component, from which commit, on
 * which Target, built by which runner.
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
            onClick={() => onNavigate(`/apps/${view.app}`)}
            className="font-semibold hover:underline"
          >
            {view.app}
          </button>
        ) : (
          <span className="font-semibold">{view.app}</span>
        )}
        <span className="mx-1.5 text-muted-foreground">/</span>
        <span className="text-subtle">{view.component}</span>
      </p>
      <dl className="ml-auto flex flex-wrap gap-x-6 gap-y-1">
        <Meta label="Commit" value={view.commit} />
        <Meta label="Target" value={view.target} />
        <Meta
          label="Runner"
          value={`${view.build.runner} · ${view.build.fidelity}`}
        />
      </dl>
    </div>
  );
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
  onRedeploy,
  redeploying = false,
}: {
  view: DeployView;
  onRedeploy?: () => void;
  redeploying?: boolean;
}) {
  return (
    <Card className="flex flex-wrap items-center gap-4 px-5 py-5">
      <div className="flex flex-col gap-2">
        <PhasePill phase={view.phase}>{view.phaseWord}</PhasePill>
        <h1 className="text-[27px] font-semibold leading-tight tracking-[-0.02em]">
          {view.headline}
        </h1>
        {onRedeploy ? (
          <Button
            variant="outline"
            size="sm"
            onClick={onRedeploy}
            disabled={redeploying}
            className="self-start"
          >
            <RefreshCw
              aria-hidden="true"
              className={cn('size-3.5', redeploying && 'animate-spin')}
            />
            {redeploying ? 'Deploying…' : 'Redeploy'}
          </Button>
        ) : null}
      </div>
      <UrlBlock view={view} />
    </Card>
  );
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
 * The build, collapsed on green.
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
  const autoOpen =
    view.build.status === 'failed' || view.build.status === 'running';
  const [open, setOpen] = useState(autoOpen);
  const priorStatus = useRef(view.build.status);

  useEffect(() => {
    if (priorStatus.current === view.build.status) return;
    priorStatus.current = view.build.status;
    setOpen(view.build.status !== 'done');
  }, [view.build.status]);

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card>
        <CollapsibleTrigger className="flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-xs font-semibold uppercase tracking-[0.07em] text-subtle hover:text-foreground">
          <StepGlyph status={view.build.status} />
          Build log · {statusWord(view.build.status)}
          {view.build.duration ? ` · ${view.build.duration}` : ''}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 px-3.5 pb-3.5">
            <Checklist items={view.build.steps} />
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
  if (view.build.log !== null) return <LogPane lines={view.build.log} />;

  if (view.build.fidelity === 'LIVE_STATUS') {
    return (
      <Notice label="LIVE_STATUS">
        {view.build.runner} reports step status live, but its log text only
        arrives when the build finishes. The checklist above is the live view.
      </Notice>
    );
  }

  return (
    <Notice label={view.build.fidelity}>
      {view.build.runner} releases its log when the build finishes.
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
