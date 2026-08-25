/**
 * The first three questions, for an installation nobody has configured (§20).
 *
 * `loadStoredManifest` seeds an unseeded row with a placeholder document, and
 * every value in it is a stand-in — the registry is somebody else's namespace,
 * the signer names a key ring that does not exist. An installation in that
 * state does not *fail*; it
 * comes up, renders an Overview of nothing, and refuses the first act an
 * operator attempts, with a message about whichever placeholder that act
 * happened to read first. This screen is what stands in front of that.
 *
 * **Everything else is derived and never asked.** The manifest is three kinds
 * of value and only one of them is a question: the deployment's own facts are
 * the chart's, the cloud's facts are discovery's, and what is left — what this
 * installation is called, whose GitHub App it speaks as, where its artifacts
 * are published — is nobody's but the operator's. So this asks four things and
 * the settings surface keeps every key. It is deliberately *not* the settings
 * form with a progress bar: a first-run screen that opened the whole document
 * would be asking somebody who has never seen this software to make thirty
 * decisions before making one.
 *
 * **It names manifest keys, and it is the one screen that may.** `installation.tsx`
 * renders whatever the schema declares and names nothing, which is what keeps it
 * correct as keys leave and arrive. A wizard cannot be written that way — asking
 * a chosen four *is* the feature — so the four are named once, in
 * {@link ONBOARDING_ASKS}, and resolved through `manifestFields()` rather than
 * rendered by hand. A key that leaves the schema therefore leaves this screen
 * as a visible refusal rather than as a control writing somewhere nothing
 * reads, and `test/web/onboarding.test.tsx` walks all four through the schema so
 * the removal is a failing test rather than a discovery.
 *
 * **One write, at the end, through `configureInstallation`.** Every step edits
 * one document held here; nothing is saved until the last screen. That is not
 * only about not half-configuring an installation — `writeStoredManifest`
 * reconciles the Targets a document declares inside the same transaction, so a
 * wizard that saved per step would run reconciliation four times over four
 * documents that were each missing something.
 *
 * **This asks three of the four the predicate reads**, which is what keeps the
 * screen coherent without making it a fourth question:
 * `isUnconfiguredInstallation` answers over the genuine choices, and because it
 * is an **and** — unconfigured means all four are still stand-ins — answering
 * any one of the three asked here is what ends onboarding. A step asking
 * something the predicate ignores would be a question whose answer changed
 * nothing, which is why the fourth ask is discovery rather than another key: it
 * writes cloud facts, nobody's choice, and it is here because confirming them is
 * cheapest while the operator is already looking at the document.
 * `secretStore.adapter` is the fourth genuine choice and is deliberately *not*
 * asked: it is one of two values, both wrong for an installation that has not
 * decided, and answering any of the other three already ends this screen. The
 * asymmetry is safe only in that direction — a predicate that answered
 * unconfigured when *any* choice was still a stand-in would hand this
 * installation, which legitimately keeps two, a wizard instead of its product.
 *
 * **What an operator can authenticate as before any of this.** Nothing here is
 * reachable without a session, and a session is a passkey ceremony scoped to
 * `controlPlane.hostname` — bound once at boot, deliberately (`serve.ts`). That
 * hostname is a deployment fact rather than an authored one: `resolveManifest`
 * takes it from `SPINDRIFT_HOSTNAME`, the same value the chart renders the
 * Gateway and the HTTPRoute from, so an installation whose document is nothing
 * but stand-ins is still served at its own real origin and can enrol somebody.
 * That is what makes this screen reachable rather than academic.
 *
 * The one installation that still cannot is the one with no origin at all —
 * reachable only in-cluster, no Gateway, nothing to scope a relying party to,
 * so `resolveManifest` falls back to `UNSERVED_HOSTNAME` and a browser
 * refuses the ceremony. That is the missing Gateway saying so, not this screen,
 * and there is nothing here to close: an installation nobody can reach is not
 * an installation waiting on a wizard.
 */
import { CircleAlert, PartyPopper, Rocket } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import type { StepStatus } from '../../../commands/views.ts';
import { command } from '../../client.ts';
import type { Path } from '../../forms/document.ts';
import { valueAt } from '../../forms/document.ts';
import { manifestFieldAt, manifestIssues } from '../../forms/manifest.ts';
import type { FieldErrors } from '../../forms/render.tsx';
import { SchemaFields } from '../../forms/render.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DiscoveryPanel } from './discovery.tsx';
import {
  issuesOf,
  Outcome,
  RestoreInstallation,
  refusalOf,
  type SaveOutcome,
} from './installation.tsx';
import { type RailStep, StepRail } from './step-rail.tsx';

/** One screen: a manifest key to confirm, or the cloud to ask. */
export type OnboardingAsk = {
  readonly title: string;
  readonly blurb: string;
} & (
  | {
      readonly kind: 'field';
      /** Where in the document the answer goes, outermost key first. */
      readonly at: Path;
    }
  | { readonly kind: 'discovery' }
);

/**
 * The three questions, in the order they are asked.
 *
 * The order is not cosmetic. The name comes first because it is the only answer
 * that needs nothing — no credential, no cloud, no prior step — so the first
 * thing an operator does is succeed. Discovery is second because it is the only
 * step that reads the world, and a step that can be slow or refuse belongs after
 * the ones that cannot. The registry is last because it is the answer most
 * likely to be a considered choice rather than a confirmation.
 *
 * GitHub is deliberately not a question. The App identity is not authored —
 * it is created through GitHub's manifest flow from the Repositories screen,
 * against the *stored* manifest — so the ceremony is offered when the
 * document has landed; see {@link OnboardingDone}.
 */
export const ONBOARDING_ASKS: readonly OnboardingAsk[] = [
  {
    kind: 'field',
    at: ['installation', 'name'],
    title: 'Name this installation',
    blurb:
      'A label for this control plane. It appears in the UI and in logs and carries no behaviour, so it is yours to pick.',
  },
  {
    kind: 'discovery',
    title: 'Confirm what the cloud says',
    blurb:
      'Read with the credential this deployment already mounts, so a project, a bucket and a signing key are confirmed rather than typed from memory.',
  },
  {
    kind: 'field',
    at: ['supplyChain', 'registry'],
    title: 'Where artifacts are published',
    blurb:
      'Every image this installation builds is pushed here and pulled from here by whatever runs it. An installation whose Targets cannot share one names several.',
  },
];

/**
 * The step that asks about a value, or `-1` for a value no step asks about.
 *
 * A wizard shows one control at a time, so an issue is only actionable on the
 * step that mounts the control it belongs to. Prefix rather than equality
 * because an issue names the value that is wrong and a step names the key it
 * asks for: a bad element of `supplyChain.registry` is reported at
 * `supplyChain.registry.0`, and the step that can fix it is the one asking for
 * `supplyChain.registry`.
 *
 * `-1` is a real answer and not a miss. Discovery applies cloud facts this
 * screen never asks for, so a document can be refused over a value with no
 * control on any step; {@link Onboarding} names those keys in the refusal
 * instead of navigating to a screen that would not show them.
 */
export function stepAsking(path: string): number {
  return ONBOARDING_ASKS.findIndex((ask) => {
    if (ask.kind !== 'field') return false;
    const at = ask.at.join('.');
    return path === at || path.startsWith(`${at}.`);
  });
}

/**
 * What is wrong with the answer the step in front of the operator asks for.
 *
 * The machinery for this has existed since the screen did and was consulted
 * exactly once, after the final write — so an empty installation name walked
 * through all three questions, and the commit press threw the operator back to
 * step one reading a sentence of dotted schema paths. The same map, filtered by
 * {@link stepAsking}, is a gate on `Continue`: an answer is checked where it is
 * given, by the schema that will refuse it, and the reason is on screen beside
 * the button that will not move.
 *
 * Exported because it is the whole of the gate and the one part of it worth
 * asserting without a browser.
 */
export function stepIssues(document: unknown, step: number): FieldErrors {
  const issues = new Map<string, readonly string[]>();
  for (const [path, messages] of manifestIssues(document)) {
    if (stepAsking(path) === step) issues.set(path, messages);
  }
  return issues;
}

/** The document's answer to one ask, as a line for the rail. */
function answerTo(document: unknown, ask: OnboardingAsk): string | undefined {
  if (ask.kind !== 'field') return undefined;
  const value = valueAt(document, ask.at);
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? value.join(', ') : String(value);
}

/**
 * The four asks as the rail draws them, against where the operator is.
 *
 * Behind is `done` rather than "answered": this screen confirms values that
 * arrive already filled in, so "has a value" is true of every step from the
 * first render and would make the rail a row of four ticks that never move.
 * What it can honestly say is which questions have been walked past — and
 * `failed` overrides that, because a step the write came back refusing is not
 * a step behind you.
 */
function railSteps(
  document: unknown,
  errors: FieldErrors,
  step: number,
): readonly RailStep[] {
  const refused = new Set([...errors.keys()].map(stepAsking));
  return ONBOARDING_ASKS.map((ask, index) => ({
    title: ask.title,
    value: answerTo(document, ask),
    status: (refused.has(index)
      ? 'failed'
      : index === step
        ? 'running'
        : index < step
          ? 'done'
          : 'waiting') satisfies StepStatus,
  }));
}

/**
 * The two maps of what is wrong, as one map for the controls.
 *
 * The server's issues and the schema's are the same kind of fact keyed the same
 * way, and a control that rendered only the first would stay silent about the
 * value that is stopping the button beside it. The server's win a collision:
 * it is the authority, and it has seen the whole document.
 */
function merged(errors: FieldErrors, blocking: FieldErrors): FieldErrors {
  if (blocking.size === 0) return errors;
  return new Map([...blocking, ...errors]);
}

/**
 * The step the URL is on, clamped, and `0` for a URL that names none.
 *
 * The hash is already this app's router, so browser Back was moving the URL
 * under a wizard that neither followed it nor noticed. Clamped rather than
 * validated because the only input is something a human typed into an address
 * bar, and the honest answer to `#/setup/9` is the last question.
 */
function stepInHash(): number {
  if (typeof location === 'undefined') return 0;
  const asked = /^#\/setup\/(\d+)/.exec(location.hash)?.[1];
  const at = asked === undefined ? 1 : Number(asked);
  return Math.min(Math.max(at - 1, 0), ONBOARDING_ASKS.length - 1);
}

/** Where the in-progress document is kept between two loads of one tab. */
const HELD = 'spindrift.setup';

/**
 * The document a reload interrupted, or `undefined` for a fresh start.
 *
 * `sessionStorage` rather than `localStorage`, and it is the one-write design
 * that decides which: nothing is stored server-side until the last press, so
 * three answers live only here — but they are answers about *this* tab's visit
 * to *this* installation, and a document surviving until next week would be a
 * document proposed against an installation somebody else has since configured.
 *
 * Every failure answers "start fresh". Storage a browser refuses, a body
 * another version of this screen wrote, a private window that throws on read —
 * none of them are worth a screen of their own, and all of them are survivable
 * by asking the three questions again.
 */
function restored(): unknown {
  try {
    const held = sessionStorage.getItem(HELD);
    const document: unknown = held === null ? null : JSON.parse(held);
    return typeof document === 'object' && document !== null
      ? document
      : undefined;
  } catch {
    return undefined;
  }
}

function remember(document: unknown): void {
  try {
    sessionStorage.setItem(HELD, JSON.stringify(document));
  } catch {
    // A browser that will not store this is a browser where F5 costs four
    // answers, which is where this screen started. It is not a refusal.
  }
}

/** A refused path, named as the question that asks about it. */
function refusedAs(path: string): string {
  const at = stepAsking(path);
  return ONBOARDING_ASKS[at]?.title ?? path;
}

/**
 * The sentence a document the schema refuses is reported with.
 *
 * The paths are what the schema keys its issues by and they are the wrong
 * vocabulary for the one screen whose whole premise is naming keys in human
 * terms — `installation.name, supplyChain.registry are not valid` was the last
 * thing an operator read before being thrown back to step one. Every path a
 * step asks about is named as that step; the rest are named as themselves,
 * because discovery writes values this screen never offers a control for and
 * pointing at a question that does not ask them would be worse than the path.
 */
export function refusalSentence(paths: readonly string[]): string {
  const asked = [
    ...new Set(paths.filter((path) => stepAsking(path) >= 0).map(refusedAs)),
  ];
  const unasked = paths.filter((path) => stepAsking(path) < 0);
  return [
    'This installation was not written.',
    asked.length === 0 ? '' : `Answer again: ${asked.join('; ')}.`,
    unasked.length === 0
      ? ''
      : `These values were refused and no question here asks about them: ${unasked.join(', ')}.`,
  ]
    .filter((part) => part !== '')
    .join(' ');
}

/**
 * Ask the four, then write the document once.
 *
 * `initial` rather than a read of its own: whoever decided this installation is
 * unconfigured had to read the manifest to know that, and re-reading it here
 * would be a second round trip for a document already in hand — and a chance
 * for the two to disagree about which document is being edited.
 */
export function Onboarding({
  initial,
  onDone,
}: {
  readonly initial: unknown;
  /**
   * Configuration landed. `next` is a path to open instead of the product's
   * own first screen, or `null` for that screen.
   */
  onDone(next: string | null): void;
}) {
  const [document, setDocument] = useState<unknown>(
    () => restored() ?? initial,
  );
  const [step, setStepState] = useState(stepInHash);
  const [errors, setErrors] = useState<FieldErrors>(new Map());
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [saving, setSaving] = useState(false);

  // The step lives in the hash and the document in `sessionStorage`, which
  // together make F5 and browser Back survivable. Both are consequences of the
  // one-write-at-the-end design rather than complaints about it: nothing is
  // stored server-side until the last press, so an in-memory document is four
  // answers that a reload silently discards — and the hash is already this
  // app's router, so Back was moving the URL under a wizard that neither
  // followed it nor noticed.
  const setStep = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), ONBOARDING_ASKS.length - 1);
    const move = () => {
      setStepState(clamped);
      if (typeof location !== 'undefined')
        location.hash = `/setup/${clamped + 1}`;
    };
    // A view transition where the browser has one, and the same swap where it
    // does not. The whole of what it buys is that the question leaving and the
    // question arriving are one movement rather than two unrelated repaints —
    // a wizard reads as one screen changing its mind, not as three screens.
    //
    // Nothing waits on it and nothing is conditional on it having run: the
    // callback is the state update either way, so a browser without the API,
    // or a reader who asked for less motion, gets the instant swap that was
    // always here.
    const view = globalThis.document as
      | { startViewTransition?: (update: () => void) => unknown }
      | undefined;
    if (typeof view?.startViewTransition === 'function') {
      view.startViewTransition(move);
    } else {
      move();
    }
  };

  useEffect(() => {
    const follow = () => setStepState(stepInHash());
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);

  useEffect(() => remember(document), [document]);

  const finish = async () => {
    // The same earlier-of-two-identical-checks the settings form runs, for the
    // same reason: the command reports every offending key in one sentence,
    // which is right for a log and wrong for a form. The command validates
    // again regardless and is the authority.
    const issues = manifestIssues(document);
    if (issues.size > 0) {
      const paths = [...issues.keys()];
      setErrors(issues);
      // Back to the step that asks about the first refused value. This screen
      // mounts one control at a time, so an issue against `installation` raised
      // on the last step is an issue rendered against a control three steps
      // back — the operator is told the manifest was refused and shown nothing
      // that says what to do. The settings form has no equivalent problem
      // because every field is mounted at once.
      //
      // An issue may still belong to no step: discovery applies cloud facts
      // this screen never asks for. Naming the keys is what that case has
      // instead of a control to point at.
      const asked = paths
        .map(stepAsking)
        .filter((at) => at >= 0)
        .sort((first, second) => first - second);
      if (asked[0] !== undefined) setStep(asked[0]);
      setOutcome({ kind: 'invalid', message: refusalSentence(paths) });
      return;
    }

    setSaving(true);
    setErrors(new Map());
    try {
      const result = await command('configureInstallation', {
        manifest: document,
      });
      if (result.ok) {
        setOutcome({ kind: 'saved', targets: result.value.targets });
      } else {
        setOutcome(refusalOf(result.failure));
        if (result.failure.code === 'INVALID_INPUT') {
          setErrors(issuesOf(result.failure));
        }
      }
    } catch (cause) {
      setOutcome({
        kind: 'failed',
        message:
          cause instanceof Error
            ? cause.message
            : 'Configuring this installation did not complete.',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingView
      step={step}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
      onChange={(next) => {
        setDocument(next);
        setOutcome(null);
      }}
      onStep={setStep}
      onFinish={() => void finish()}
      onRestored={setOutcome}
      onDone={onDone}
    />
  );
}

/**
 * What is on screen, with nothing to fetch.
 *
 * Split from the state above for the reason `InstallationSettingsView` is: every
 * claim worth making about a wizard is a claim about *what a given step shows*,
 * and a component that owned its own step could only ever be asserted on its
 * first one.
 */
export function OnboardingView({
  step,
  document,
  errors,
  outcome,
  saving,
  onChange,
  onStep,
  onFinish,
  onRestored,
  onDone,
}: {
  readonly step: number;
  readonly document: unknown;
  readonly errors: FieldErrors;
  readonly outcome: SaveOutcome | null;
  readonly saving: boolean;
  onChange(document: unknown): void;
  onStep(step: number): void;
  onFinish(): void;
  /**
   * A document arrived from a file instead of from the three questions. The
   * same outcome the last press produces, because it is the same write.
   */
  onRestored(outcome: SaveOutcome): void;
  onDone(next: string | null): void;
}) {
  // A saved document is the end of this screen's job, whatever step it was on.
  if (outcome?.kind === 'saved') {
    return (
      <OnboardingShell>
        <OnboardingDone targets={outcome.targets} onDone={onDone} />
      </OnboardingShell>
    );
  }

  const ask = ONBOARDING_ASKS[step];
  if (ask === undefined) return null;
  const last = step === ONBOARDING_ASKS.length - 1;
  // What the schema says about the answer in front of the operator, now, rather
  // than what it will say after the write. The map exists either way; consulting
  // it here is the difference between a refusal beside the control that caused
  // it and a refusal three steps later naming a dotted path.
  const blocking = stepIssues(document, step);
  const held = [...blocking.values()][0]?.[0];
  // The discovery step is the one with no form around it, so its primary button
  // has nothing to submit — a `type="submit"` outside a form is a button that
  // does nothing when pressed, which is how this step would have shipped.
  const submits = ask.kind !== 'discovery';
  const advance = () => {
    if (blocking.size > 0) return;
    if (last) onFinish();
    else onStep(step + 1);
  };
  const form = {
    document,
    errors: merged(errors, blocking),
    disabled: saving,
    // One question on screen, so the control that asks it is where the cursor
    // belongs. The first interaction with this product was a mouse hunt for the
    // only box on the page.
    autoFocus: true,
    onChange,
  };

  const body = (
    <>
      {/* Keyed by the step so React remounts it, which is what replays the
          animation: a question is a new question, not the last one edited. */}
      <Card key={step} className="motion-safe:animate-rise">
        <CardHeader>
          <Rocket aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
          <div>
            <p className="text-caption font-semibold uppercase tracking-eyebrow text-muted-foreground">
              Step {step + 1} of {ONBOARDING_ASKS.length}
            </p>
            <CardTitle>{ask.title}</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">{ask.blurb}</p>
          </div>
        </CardHeader>
        <CardContent>
          {ask.kind === 'discovery' ? (
            // The same panel the settings surface mounts, editing the same
            // document through the same `onChange`. A confirmed value is an
            // unsaved edit here exactly as it is there.
            <DiscoveryPanel
              document={document}
              disabled={saving}
              onChange={onChange}
            />
          ) : (
            <AskedField at={ask.at} form={form} />
          )}
        </CardContent>
      </Card>

      <Outcome outcome={outcome} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        {step === 0 ? (
          // Nothing to go back to on the first question, and the one thing an
          // operator might be here to do instead of answering it: a torn-down
          // installation comes back from the file it exported, rather than from
          // whatever document a chart happened to mount.
          <RestoreInstallation disabled={saving} onRestored={onRestored} />
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={saving}
            onClick={() => onStep(step - 1)}
          >
            Back
          </Button>
        )}
        <div className="flex items-center gap-3">
          {/* Whatever the button is currently mumbling, said out loud. A
              ceremony that takes as long as a cloud write takes was announced
              to a screen reader by nothing at all. */}
          <p
            role="status"
            aria-live="polite"
            className="text-xs text-muted-foreground"
          >
            {saving
              ? 'Writing this installation…'
              : held === undefined
                ? ''
                : held}
          </p>
          <Button
            type={submits ? 'submit' : 'button'}
            disabled={saving || blocking.size > 0}
            onClick={submits ? undefined : advance}
          >
            {last
              ? saving
                ? 'Configuring…'
                : 'Configure this installation'
              : 'Continue'}
          </Button>
        </div>
      </div>
    </>
  );

  return (
    <OnboardingShell
      rail={
        <StepRail
          steps={railSteps(document, errors, step)}
          current={step}
          onJump={saving ? undefined : onStep}
        />
      }
    >
      <div>
        {ask.kind === 'discovery' ? (
          // The one step with no form of its own, because it already has one:
          // the discovery panel submits its narrowing, and a form nested in a
          // form is markup a browser repairs into something neither meant.
          <div className="flex flex-col gap-6">{body}</div>
        ) : (
          <form
            className="flex flex-col gap-6"
            onSubmit={(event) => {
              event.preventDefault();
              advance();
            }}
          >
            {body}
          </form>
        )}
      </div>
    </OnboardingShell>
  );
}

/** One asked key, rendered by the schema rather than by hand. */
function AskedField({
  at,
  form,
}: {
  readonly at: Path;
  readonly form: Parameters<typeof SchemaFields>[0]['form'];
}) {
  const field = manifestFieldAt(at);
  if (field === null) {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground"
      >
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <p className="font-medium">
            This build cannot ask that question here.
          </p>
          <p className="mt-0.5">
            The key it asks about is not in this build&apos;s manifest schema,
            so there is nothing to write. Everything this installation has is
            editable in Settings once you are through.
          </p>
        </div>
      </div>
    );
  }
  return <SchemaFields fields={[field]} at={at.slice(0, -1)} form={form} />;
}

/**
 * Configuration landed, and the one thing that could not happen until it did.
 *
 * The manifest flow that creates the GitHub App renders its redirect URLs off
 * the stored manifest, so this is the first moment that creation can actually
 * run — and it runs on the connections screen, which owns that ceremony.
 */
function OnboardingDone({
  targets,
  onDone,
}: {
  readonly targets: readonly string[];
  onDone(next: string | null): void;
}) {
  return (
    <Card>
      <CardHeader>
        <PartyPopper aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <CardTitle>This installation is configured.</CardTitle>
          {targets.length === 0 ? (
            <p className="mt-1 text-sm text-muted-foreground">
              It declares no Targets yet. Connect one from Settings when there
              is somewhere to deploy.
            </p>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Targets reconciled, in rank order:
              </p>
              {/* One at a time, in the order the write worked them: the
                  reconciliation really is sequential inside one transaction,
                  and rank really is the order, so the stagger is the shape of
                  what happened rather than an effect over a finished list.
                  Still one sentence to a reader who cannot see it — the list
                  is comma-separated text with the delay on each item. */}
              <ul className="mt-1 flex flex-wrap gap-x-1 text-sm text-muted-foreground">
                {targets.map((target, index) => (
                  <li
                    key={target}
                    className="motion-safe:animate-rise font-mono text-xs"
                    style={
                      {
                        '--i': index,
                        animationDelay: 'calc(var(--i) * 60ms)',
                      } as CSSProperties
                    }
                  >
                    {target}
                    {index === targets.length - 1 ? '.' : ','}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          Everything else this installation names — its zones, its Targets, its
          build routes — is in Settings, and nothing here has to be right
          forever.
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => onDone('/settings/connections')}>
            Connect GitHub
          </Button>
          <Button type="button" variant="outline" onClick={() => onDone(null)}>
            Open this installation
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The frame, which is the product's chrome deliberately absent.
 *
 * An unconfigured installation has no Apps, no Builds and no Targets, so the
 * navigation that reaches them would be five links to five empty screens and a
 * sixth to the settings form this screen exists to stand in front of.
 *
 * What it does have is a fixed position. The column was vertically centred, and
 * step three mounts a discovery panel that grows by five rows when the cloud
 * answers — so every Continue, and every successful ask, slid the whole screen
 * under the reader. A wizard reads as built mostly because its chrome does not
 * move, so the header and the rail are pinned and only the step changes height.
 */
function OnboardingShell({
  rail,
  children,
}: {
  /** The three questions, when there are three questions to show. */
  readonly rail?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[880px] flex-col gap-8 px-5 pb-16 pt-[12vh]">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="font-mono text-xl font-bold tracking-[0.25em] text-foreground">
          SPINDRIFT
        </span>
        <p className="text-xs text-muted-foreground">
          Nothing here is configured yet. Three answers and it is.
        </p>
      </div>
      {rail === undefined ? (
        <div className="mx-auto w-full max-w-[640px]">{children}</div>
      ) : (
        <div className="grid gap-8 md:grid-cols-[210px_minmax(0,1fr)]">
          <div className="md:sticky md:top-8 md:self-start">{rail}</div>
          <div className="min-w-0">{children}</div>
        </div>
      )}
    </main>
  );
}
