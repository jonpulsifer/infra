/**
 * First-run setup for an unconfigured installation. The steps edit one
 * document, and `configureInstallation` writes it once: each write reconciles
 * Targets.
 */
import { CircleAlert, PartyPopper, Rocket } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useState } from 'react';
import type { StepStatus } from '../../../commands/views.ts';
import { command } from '../../client.ts';
import { Roflcopter } from '../../components/roflcopter.tsx';
import { Wordmark } from '../../components/wordmark.tsx';
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
 * In the order asked: the name needs nothing, and discovery can be slow or
 * refuse. The GitHub App is created after the write, from the stored manifest.
 * Each asked key is one `isUnconfiguredInstallation` reads, so answering any
 * one ends onboarding.
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
 * The step asking about `path`, or `-1`. A prefix match, since an issue at
 * `supplyChain.registry.0` belongs to the step asking `supplyChain.registry`.
 */
export function stepAsking(path: string): number {
  return ONBOARDING_ASKS.findIndex((ask) => {
    if (ask.kind !== 'field') return false;
    const at = ask.at.join('.');
    return path === at || path.startsWith(`${at}.`);
  });
}

/** Schema issues for the current step, which gate Continue. */
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
 * A walked-past step is `done`, since every value arrives pre-filled. A step
 * the write refused is `failed` wherever it is.
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

/** Issues from the last write attempt win a collision with the step check. */
function merged(errors: FieldErrors, blocking: FieldErrors): FieldErrors {
  if (blocking.size === 0) return errors;
  return new Map([...blocking, ...errors]);
}

/** The step the hash names, clamped: `#/setup/9` opens the last one. */
function stepInHash(): number {
  if (typeof location === 'undefined') return 0;
  const asked = /^#\/setup\/(\d+)/.exec(location.hash)?.[1];
  const at = asked === undefined ? 1 : Number(asked);
  return Math.min(Math.max(at - 1, 0), ONBOARDING_ASKS.length - 1);
}

/** Session storage, so an unsaved document never outlives its tab. */
const HELD = 'spindrift.setup';

/** Any failure to read the held document starts fresh. */
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
    // Without storage, a reload loses the answers; nothing else breaks.
  }
}

/** A refused path, named as the question that asks about it. */
function refusedAs(path: string): string {
  const at = stepAsking(path);
  return ONBOARDING_ASKS[at]?.title ?? path;
}

/**
 * Names each refused path as the step that asks it. Paths discovery wrote
 * have no step, so they are named as themselves.
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

/** `initial` is the manifest the caller already read to find it unconfigured. */
export function Onboarding({
  initial,
  onDone,
}: {
  readonly initial: unknown;
  /** `next` is a path to open, or `null` for the product's first screen. */
  onDone(next: string | null): void;
}) {
  const [document, setDocument] = useState<unknown>(
    () => restored() ?? initial,
  );
  const [step, setStepState] = useState(stepInHash);
  const [errors, setErrors] = useState<FieldErrors>(new Map());
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [saving, setSaving] = useState(false);

  // The step lives in the hash and the document in session storage, so reload
  // and Back both survive.
  const setStep = (next: number) => {
    const clamped = Math.min(Math.max(next, 0), ONBOARDING_ASKS.length - 1);
    const move = () => {
      setStepState(clamped);
      if (typeof location !== 'undefined')
        location.hash = `/setup/${clamped + 1}`;
    };
    // A view transition where the browser has one; `move` runs either way.
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
    // Checked here so each issue reaches its field; the command validates
    // again and has the final say.
    const issues = manifestIssues(document);
    if (issues.size > 0) {
      const paths = [...issues.keys()];
      setErrors(issues);
      // Back to the step asking the first refused value, since only one step's
      // control is mounted. Values discovery wrote have no step.
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

/** Stateless, so a test can render any step. */
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
  /** A document restored from a file, reported like the final write. */
  onRestored(outcome: SaveOutcome): void;
  onDone(next: string | null): void;
}) {
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
  const blocking = stepIssues(document, step);
  const held = [...blocking.values()][0]?.[0];
  // The discovery step has no form around it, so a submit button would do
  // nothing.
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
    // One question on screen, so its control takes focus.
    autoFocus: true,
    onChange,
  };

  const body = (
    <>
      {/* Keyed by step, so each question remounts and replays the animation. */}
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
          // No form here: the discovery panel submits its own, and forms cannot
          // nest.
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

/** One asked key, rendered from the manifest schema. */
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
 * The GitHub App's manifest flow reads the stored manifest, so it can run only
 * after this write. The connections screen runs it.
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
              {/* Staggered in rank order, the order the write reconciled them.
                  A screen reader hears one comma-separated sentence. */}
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
 * No product navigation, since every screen it reaches is empty. The header
 * and rail stay put while the step changes height.
 */
function OnboardingShell({
  rail,
  children,
}: {
  /** Absent on the finished screen. */
  readonly rail?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <Roflcopter />
      <main className="mx-auto flex min-h-dvh w-full max-w-[880px] flex-col gap-8 px-5 pb-16 pt-[12vh]">
        <div className="flex flex-col items-center gap-2 text-center">
          <Wordmark setting="hero" className="text-foreground" />
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
    </>
  );
}
