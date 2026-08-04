/**
 * The first four questions, for an installation nobody has configured (§20).
 *
 * `loadStoredManifest` seeds an unseeded row with a placeholder document, and
 * every value in it is a stand-in — the registry is somebody else's namespace,
 * the signer names a key ring that does not exist, the control plane is served
 * at an example hostname. An installation in that state does not *fail*; it
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
 * **What an operator can authenticate as before any of this.** Nothing here is
 * reachable without a session, and a session is a passkey ceremony scoped to
 * `controlPlane.hostname` — bound once at boot, deliberately (`serve.ts`), and
 * on an unconfigured installation that value is the placeholder's. A browser
 * refuses a ceremony whose relying party is not a suffix of the origin it is
 * on, so an installation that has nothing but the placeholder cannot enrol
 * anybody, and this screen sits behind a door that installation cannot open.
 * That is a real gap and it is not this screen's to close: the hostname is a
 * deployment fact the chart already knows and the manifest is not given, and
 * moving where the relying party resolves from changes which origins ceremonies
 * are accepted at — a change whose only honest proof is a live enrolment. Until
 * that lands, onboarding is reachable exactly for an installation whose
 * hostname is already right and whose remaining values are not.
 */
import { CircleAlert, PartyPopper, Rocket } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { command } from '../../client.ts';
import type { Path } from '../../forms/document.ts';
import { manifestFields, manifestIssues } from '../../forms/manifest.ts';
import type { FieldErrors } from '../../forms/render.tsx';
import { SchemaFields } from '../../forms/render.tsx';
import type { FormField } from '../../forms/schema.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { DiscoveryPanel } from './discovery.tsx';
import {
  issuesOf,
  Outcome,
  refusalOf,
  type SaveOutcome,
} from './installation.tsx';

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
 * The four questions, in the order they are asked.
 *
 * The order is not cosmetic. The name comes first because it is the only answer
 * that needs nothing — no credential, no cloud, no prior step — so the first
 * thing an operator does is succeed. GitHub is second because the artifacts
 * step below it is about publishing what GitHub's repositories produce, and
 * confirming the client id here is what makes the authorization on the far side
 * of this screen able to run at all. Discovery is third because it is the only
 * step that reads the world, and a step that can be slow or refuse belongs after
 * the ones that cannot. The registry is last because it is the answer most
 * likely to be a considered choice rather than a confirmation.
 *
 * `github.clientId` is the value, not the authorization ceremony:
 * `beginRepositoryAuthorization` reads the client id off the *stored* manifest,
 * so a device flow started here would run against the placeholder's. The
 * ceremony is offered when the document has landed — see {@link OnboardingDone}
 * — which is also where it already exists, tested, on the connections screen.
 */
export const ONBOARDING_ASKS: readonly OnboardingAsk[] = [
  {
    kind: 'field',
    at: ['installation'],
    title: 'Name this installation',
    blurb:
      'A label for this control plane. It appears in the UI and in logs and carries no behaviour, so it is yours to pick.',
  },
  {
    kind: 'field',
    at: ['github', 'clientId'],
    title: 'Connect GitHub',
    blurb:
      'The GitHub App this installation speaks as. Nothing is authorized yet — that ceremony needs this value stored first, and it is offered as soon as it is.',
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
 * The schema's description of one key, by path.
 *
 * `null` for a path this build's schema does not have, which is rendered as a
 * refusal rather than skipped: a wizard that quietly dropped a question would
 * finish having configured less than it said it did.
 */
export function manifestFieldAt(at: Path): FormField | null {
  let fields: readonly FormField[] = manifestFields();
  let found: FormField | null = null;
  for (const step of at) {
    found = fields.find((field) => field.key === step) ?? null;
    if (found === null) return null;
    fields = found.node.kind === 'object' ? found.node.fields : [];
  }
  return found;
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
  const [document, setDocument] = useState<unknown>(initial);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<FieldErrors>(new Map());
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [saving, setSaving] = useState(false);

  const finish = async () => {
    // The same earlier-of-two-identical-checks the settings form runs, for the
    // same reason: the command reports every offending key in one sentence,
    // which is right for a log and wrong for a form. The command validates
    // again regardless and is the authority.
    const issues = manifestIssues(document);
    if (issues.size > 0) {
      setErrors(issues);
      setOutcome({
        kind: 'invalid',
        message: 'This installation was not written, because it is not valid.',
      });
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
  const form = { document, errors, disabled: saving, onChange };

  return (
    <OnboardingShell>
      <Card>
        <CardHeader>
          <Rocket aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
          <div>
            <p className="text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
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

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="outline"
          disabled={saving || step === 0}
          onClick={() => onStep(step - 1)}
        >
          Back
        </Button>
        {last ? (
          <Button type="button" disabled={saving} onClick={onFinish}>
            {saving ? 'Configuring…' : 'Configure this installation'}
          </Button>
        ) : (
          <Button
            type="button"
            disabled={saving}
            onClick={() => onStep(step + 1)}
          >
            Continue
          </Button>
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
 * GitHub's device flow reads `github.clientId` off the stored manifest, so this
 * is the first moment the authorization an operator was promised on step two
 * can actually run — and it runs on the connections screen, which already owns
 * that ceremony and its polling.
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
          <p className="mt-1 text-sm text-muted-foreground">
            {targets.length === 0
              ? 'It declares no Targets yet. Connect one from Settings when there is somewhere to deploy.'
              : `Targets reconciled, in rank order: ${targets.join(', ')}.`}
          </p>
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
            Authorize GitHub
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
 */
function OnboardingShell({ children }: { readonly children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col justify-center gap-6 px-5 py-12">
      <div className="flex flex-col items-center gap-2 text-center">
        <span className="font-mono text-xl font-bold tracking-[0.25em] text-foreground">
          SPINDRIFT
        </span>
        <p className="text-xs text-muted-foreground">
          Nothing here is configured yet. Four answers and it is.
        </p>
      </div>
      {children}
    </main>
  );
}
