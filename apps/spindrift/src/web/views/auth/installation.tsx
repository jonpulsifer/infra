/**
 * The installation manifest, edited in the product (§20, ticket 32 slice 1).
 *
 * §20 makes the manifest the place everything naming an installation lives, and
 * `manifest-store.ts` has always said the point of storing it durably is "so
 * the UI can drive all configuration dynamically". `configureInstallation`
 * built the write; this is the hand that reaches it. Until both exist, a value
 * seeded wrong stays wrong for the life of the installation — a declaration
 * only seeds an empty row, so re-declaring it changes nothing once a row is
 * there.
 *
 * **Rendered from the schema, not from a list of fields.** The keys, their
 * kinds, their optionality and their order all come from
 * `installationManifestSchema` through `forms/schema.ts`. That is a correctness
 * requirement rather than a preference: the manifest is losing keys to the
 * chart and gaining discovery, and a hand-listed form absorbs neither — it
 * would keep offering a key that no longer exists and quietly never offer one
 * that appeared. Nothing in this file names a manifest key.
 *
 * **Refusals are not flattened.** `configureInstallation` can refuse in three
 * different ways and they mean three different things, so they read three
 * different ways here:
 *
 * - `INVALID_INPUT` — the document is wrong, and there is a field to fix. The
 *   issues land against the paths that caused them.
 * - `NOT_DEPLOYABLE` — the document is well formed and this installation cannot
 *   take it, because reconciling the Targets it declares meets the ones that
 *   already exist. Nothing was written and no field is wrong; telling an
 *   operator to correct a key here would be a lie.
 * - anything else — a transport or session refusal, which is about the request
 *   rather than the manifest.
 *
 * **The concurrent-edit cost, carried not compounded.** There is no revision
 * column on `installation`, so two operators saving at once lose one edit
 * whole; `STALE_EDIT` exists for that shape and stays unused while this is the
 * one editing surface. This screen does not add a second: it reads once, edits
 * a document, saves it whole, and re-reads what was stored afterwards, so the
 * next edit starts from the row rather than from a stale copy. Reload discards
 * local edits for the same reason.
 */
import {
  CircleAlert,
  CircleCheck,
  RotateCcw,
  Server,
  Sliders,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { governedManifestPaths } from '../../../config/manifest.schema.ts';
import type { TransportFailure } from '../../client.ts';
import { command } from '../../client.ts';
import type { Path } from '../../forms/document.ts';
import { pathKey } from '../../forms/document.ts';
import { manifestFields, manifestIssues } from '../../forms/manifest.ts';
import type { FieldErrors } from '../../forms/render.tsx';
import { SchemaFields } from '../../forms/render.tsx';
import type { FormField } from '../../forms/schema.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';
import { Skeleton } from '../../ui/skeleton.tsx';
import { DiscoveryPanel } from './discovery.tsx';

/** What the last save attempt produced. */
export type SaveOutcome =
  | { readonly kind: 'saved'; readonly targets: readonly string[] }
  /** The document is wrong, and the issues say where. */
  | { readonly kind: 'invalid'; readonly message: string }
  /** A fact about this installation, not a field to correct. */
  | { readonly kind: 'refused'; readonly message: string }
  /** The request itself did not get to be an answer about the manifest. */
  | { readonly kind: 'failed'; readonly message: string };

export function InstallationSettings() {
  const [document, setDocument] = useState<unknown>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>(new Map());
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [divergence, setDivergence] = useState<readonly string[]>([]);
  /**
   * The mounted declaration, whole — what an "Adopt this declaration" press
   * sends to `configureInstallation` unedited. `null` until the first load
   * answers, and whenever nothing is mounted; `ManifestDivergenceNotice` does
   * not offer the act without it.
   */
  const [declaration, setDeclaration] = useState<unknown>(null);
  /**
   * Whether that declaration takes the governed slice back on every boot.
   *
   * Separate from `declaration` because a mounted document and a governing one
   * are different facts, and the chart-only install is where they part: the
   * chart mounts its stand-in to bind the relying party, and a stand-in governs
   * nothing. Answered by the server (`getInstallationManifest`) rather than
   * decided here, so this screen locks exactly what `configureInstallation`
   * would refuse — never a field it would have accepted.
   */
  const [declarationGoverns, setDeclarationGoverns] = useState(false);

  const load = useCallback(async () => {
    const result = await command('getInstallationManifest', {});
    if (result.ok) {
      setDocument(result.value.manifest);
      setDivergence(result.value.declarationDivergence);
      setDeclaration(result.value.declaration);
      setDeclarationGoverns(result.value.declarationGoverns);
      setLoadError(null);
    } else {
      setLoadError(result.failure.message);
    }
  }, []);

  useEffect(() => {
    void load().catch((cause: unknown) =>
      setLoadError(
        cause instanceof Error
          ? cause.message
          : 'This installation could not be read.',
      ),
    );
  }, [load]);

  const save = async () => {
    // Checked here first so the issues can be shown against the fields that
    // caused them: `configureInstallation` reports every offending key at once
    // in one sentence, which is the right shape for a log and the wrong shape
    // for a form. The command validates again regardless — it is the authority,
    // and this is only the earlier of two identical checks against the same
    // schema module.
    const issues = manifestIssues(document);
    if (issues.size > 0) {
      setErrors(issues);
      setOutcome({
        kind: 'invalid',
        message: 'This manifest is not valid, so nothing was written.',
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
        // What the row now holds, rather than what was sent: the two are the
        // same document only when nothing else wrote in between, and this
        // screen has no revision to notice that with.
        await load();
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
          cause instanceof Error ? cause.message : 'The save did not complete.',
      });
    } finally {
      setSaving(false);
    }
  };

  if (loadError !== null) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-terminal-destructive">{loadError}</p>
        </CardContent>
      </Card>
    );
  }

  if (document === undefined) {
    // The shape that is coming, not a sentence where it will be: this screen
    // resolves into a page header and a column of cards, and a single grey line
    // meant the whole surface jumped into place under the reader. The sentence
    // stays as the thing announced, because a screen reader cannot see a
    // rectangle.
    return (
      <div className="flex flex-col gap-6">
        <p role="status" aria-live="polite" className="sr-only">
          Loading this installation…
        </p>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-3 w-96 max-w-full" />
        </div>
        {[0, 1, 2].map((card) => (
          <Card key={card}>
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-9" />
              <Skeleton className="h-9" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  return (
    <InstallationSettingsView
      fields={manifestFields()}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
      divergence={divergence}
      declaration={declaration}
      declarationGoverns={declarationGoverns}
      onChange={(next) => {
        setDocument(next);
        setOutcome(null);
      }}
      onSave={() => void save()}
      onReload={() => {
        setErrors(new Map());
        setOutcome(null);
        void load();
      }}
      onAdopted={() => {
        // The row changed under this screen exactly as a `configureInstallation`
        // save does, so it is re-read the same way: what the write left, not
        // what was sent, and any local edit below it is discarded along with
        // it — the notice says so before the press that causes it.
        setErrors(new Map());
        setOutcome(null);
        void load();
      }}
    />
  );
}

/**
 * A refusal, kept in the three kinds the command actually draws.
 *
 * Exported so onboarding refuses in the same three kinds rather than in a
 * second reading of the same codes: the distinction `NOT_DEPLOYABLE` draws is
 * the one a form is most likely to flatten, and two screens that flattened it
 * differently would be two different lies.
 */
export function refusalOf(failure: TransportFailure): SaveOutcome {
  switch (failure.code) {
    case 'INVALID_INPUT':
      return { kind: 'invalid', message: failure.message };
    case 'NOT_DEPLOYABLE':
      return { kind: 'refused', message: failure.message };
    default:
      return { kind: 'failed', message: failure.message };
  }
}

/** Server-reported issues, keyed the way the form keys its controls. */
export function issuesOf(failure: TransportFailure): FieldErrors {
  const errors = new Map<string, string[]>();
  for (const issue of failure.issues ?? []) {
    // The dispatch layer paths an issue from the command's *input*, whose one
    // key is the document. The form's paths are into the document itself.
    const path = issue.path.replace(/^manifest\.?/, '');
    const existing = errors.get(path);
    if (existing === undefined) {
      errors.set(path, [issue.message]);
    } else {
      existing.push(issue.message);
    }
  }
  return errors;
}

export function InstallationSettingsView({
  fields,
  document,
  errors,
  outcome,
  saving,
  divergence = [],
  declaration = null,
  declarationGoverns = false,
  onChange,
  onSave,
  onReload,
  onAdopted,
}: {
  readonly fields: readonly FormField[];
  readonly document: unknown;
  readonly errors: FieldErrors;
  readonly outcome: SaveOutcome | null;
  readonly saving: boolean;
  /**
   * Dotted paths where the mounted declaration disagrees with what is shown
   * below, from `getInstallationManifest`. Optional, and defaulted to `[]`
   * rather than required, so a test rendering this view for the ordinary case
   * — no declaration mounted, or nothing seeded yet — states nothing about a
   * fact it is not exercising.
   */
  readonly divergence?: readonly string[];
  /**
   * The mounted declaration itself, from the same command as `divergence` —
   * `getInstallationManifest`'s `declaration`. What "Adopt this declaration"
   * sends to `configureInstallation`, unedited. Optional and defaulted to
   * `null` for the same reason `divergence` is; the notice offers no adopt
   * act without it, which a test asserting only `divergence` is still
   * entitled to leave unset.
   */
  readonly declaration?: unknown;
  /**
   * Whether {@link declaration} governs. Defaults to `false` so a caller that
   * passes neither locks nothing, which is the honest answer for a screen with
   * no declaration behind it.
   */
  readonly declarationGoverns?: boolean;
  onChange(document: unknown): void;
  onSave(): void;
  onReload(): void;
  /**
   * The row changed underneath this screen by a route other than `onSave` —
   * an adopt press. Optional because a caller that never passes a
   * `declaration` has no act to report finishing; `ManifestDivergenceNotice`
   * does not render the button that would need it.
   */
  onAdopted?(): void;
}) {
  // The slice the mounted declaration takes back on every boot. Read-only here
  // rather than accepted and reverted: `configureInstallation` refuses a
  // document that edits it, and a field an operator can type into but not save
  // is a field that teaches them the wrong thing about who owns it. Still no
  // key named in this file — the paths come from the schema module that owns
  // them, resolved against the document being edited.
  const governed = governedManifestPaths(
    declarationGoverns ? declaration : null,
    document,
  ).map(pathKey);
  const locked = (at: Path) => {
    const here = pathKey(at);
    return governed.some((key) => here === key || here.startsWith(`${key}.`));
  };
  const form = { document, errors, disabled: saving, locked, onChange };
  // Sections are whichever keys have structure. Derived rather than listed, so
  // a key that changes shape moves itself between the two halves.
  const nested = fields.filter(
    (field) => field.node.kind === 'object' || field.node.kind === 'array',
  );
  const plain = fields.filter((field) => !nested.includes(field));

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <Sliders aria-hidden="true" className="size-4 text-subtle" />
          Installation manifest
        </h2>
        <p className="text-sm text-muted-foreground">
          Everything that names this installation. Saving writes the whole
          document and reconciles the Targets it declares.
        </p>
      </div>

      <ManifestDivergenceNotice
        paths={divergence}
        declaration={declaration}
        onAdopted={onAdopted}
      />

      <GovernedSliceNotice locked={governed.length > 0} />

      {/* Above the form, because it is the step that comes before editing: a
          value confirmed from the cloud is a value nobody has to type, and one
          typed here is a value nothing checked. It edits the same document
          through the same `onChange`, so a discovered value is an unsaved edit
          like any other until the whole manifest is saved. */}
      <DiscoveryPanel
        document={document}
        disabled={saving}
        locked={locked}
        onChange={onChange}
      />

      {/* Not a card. Every one of this schema's top-level keys has structure,
          so `plain` is empty for every manifest this build can hold — and a
          card was drawn around it anyway, which put a titled, blurbed, and
          permanently empty box above the twelve cards that are the actual
          document. The copy was never a section's: it is what this whole page
          is, so it is the page's. The keys keep a home for the day the schema
          grows a scalar, and it is a plain fieldset rather than a card, because
          a card with nothing in it is the thing being deleted. */}
      {plain.length === 0 ? null : (
        <SchemaFields fields={plain} at={[]} form={form} />
      )}

      {nested.map((field) => (
        <Card key={field.key}>
          <CardHeader>
            <div>
              <CardTitle>{field.label}</CardTitle>
              {field.description ? (
                <p className="mt-1 text-sm text-muted-foreground">
                  {field.description}
                </p>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {field.node.kind === 'object' &&
            !field.optional &&
            !field.nullable ? (
              // A required object is its keys — the card's own title already
              // names it, and repeating the label inside would be the same
              // word twice. A key that may be absent keeps its wrapper,
              // because the wrapper is where "not configured" is said.
              <SchemaFields
                fields={field.node.fields}
                at={[field.key]}
                form={form}
              />
            ) : (
              <SchemaFields fields={[field]} at={[]} form={form} />
            )}
          </CardContent>
        </Card>
      ))}

      <Outcome outcome={outcome} />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save this installation'}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={saving}
          onClick={onReload}
        >
          <RotateCcw aria-hidden="true" />
          Discard edits and re-read
        </Button>
      </div>
    </form>
  );
}

/**
 * Why some of the fields below cannot be typed into.
 *
 * The sentence rather than a tooltip on each control, and the same sentence
 * `views/targets/list.tsx` renders on a governed Target's card: these two
 * boundaries reconcile from the mounted declaration on every boot, so an edit
 * accepted here would survive exactly until the next restart — with the screen
 * that accepted it then showing the old values and no reason. A lock with no
 * sentence beside it reads as a bug in the form.
 *
 * Not a refusal: nothing failed and nothing here is wrong to fix, so it takes
 * the neutral voice `Outcome`'s `refused` arm uses rather than the destructive
 * one.
 */
function GovernedSliceNotice({ locked }: { readonly locked: boolean }) {
  if (!locked) return null;
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground">
      <Server aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
      <div>
        <p className="font-medium">
          The vessels this installation is built on are declared, not configured
          here.
        </p>
        <p className="mt-0.5 text-muted-foreground">
          This installation reconciles them from the mounted declaration on
          every boot, so they are read-only below and a save that changed one
          would be refused. Change the declaration instead.
        </p>
      </div>
    </div>
  );
}

/**
 * The one thing this screen says that is not about the last save: the
 * mounted declaration and the document below no longer agree.
 *
 * `loadStoredManifest` seeds from a declaration and, once seeded, ignores
 * it — deliberately, so a rollout can never revert what an operator just
 * configured here. The cost of that rule is that a declaration can drift for
 * a long time with nothing but a boot-time pod log to say so, which is how
 * PR #1607 moved a Target's gateway in the declaration while the row this
 * screen edits kept pointing at the one that PR deleted. This notice is that
 * same fact, read where an operator actually looks rather than where a
 * rollout happened to leave it.
 *
 * Not a refusal — nothing failed, and nothing here is wrong to fix — so it
 * renders beside `Outcome` rather than as one of its arms, and it is present
 * whenever `divergence` is non-empty rather than only after a save.
 *
 * **Paths only**, exactly as `getInstallationManifest` answers them: the list
 * says where the two documents disagree, never what either one says at that
 * path.
 *
 * **Adopting sends `declaration` whole, the same way `onSave` sends the
 * edited document.** `declaration` is already an `AuthoredManifest` —
 * `configureInstallation`'s own input type — so this is not a patch applied
 * at `paths`: "apply only the diverging paths" would let a partially valid
 * document through, which is exactly what a manifest must never be. The cost
 * is stated next to the button that causes it, before the press rather than
 * after: a `declared` write resets the assessment of every Target whose
 * connection moves to an unhealthy, awaiting-inspection checklist
 * (`manifest-store.ts`'s `reconcileManifestTargets`) — which is what most of
 * a divergence like this one actually is, because a Target's connection is
 * exactly what a rollout to `helm-release.yaml` most often moves. Said
 * plainly rather than behind a second confirming click: the sentence is the
 * same regardless of which paths differ, so a click that only reveals it
 * would cost an operator a step without giving them anything to decide with
 * that they could not already read.
 */
function ManifestDivergenceNotice({
  paths,
  declaration,
  onAdopted,
}: {
  readonly paths: readonly string[];
  /** The document an adopt press submits, whole. `null` offers no press. */
  readonly declaration?: unknown;
  onAdopted?(): void;
}) {
  const [adopting, setAdopting] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);

  if (paths.length === 0) return null;

  const adopt = async () => {
    setAdopting(true);
    setAdoptError(null);
    try {
      const result = await command('configureInstallation', {
        manifest: declaration,
      });
      if (result.ok) {
        onAdopted?.();
      } else {
        setAdoptError(result.failure.message);
      }
    } catch (cause) {
      setAdoptError(
        cause instanceof Error
          ? cause.message
          : 'Adopting the declaration failed.',
      );
    } finally {
      setAdopting(false);
    }
  };

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
      <div className="w-full">
        <p className="font-medium">
          The mounted declaration no longer matches this installation.
        </p>
        <p className="mt-0.5">
          Configuration is this screen's to drive, so what is stored below is
          what is running — the declaration was only ever the seed.
        </p>
        <p className="mt-1 text-muted-foreground">
          Differs at: {paths.join(', ')}.
        </p>

        {declaration === null || declaration === undefined ? null : (
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">
              Adopting replaces the document below with the declaration above,
              whole — discarding any unsaved edit here along with it. Every
              Target whose connection moves is reset to unhealthy, with an
              awaiting-inspection checklist, until it is re-inspected.
            </p>
            {adoptError !== null ? (
              <p className="text-terminal-destructive">{adoptError}</p>
            ) : null}
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={adopting}
                onClick={() => void adopt()}
              >
                {adopting ? 'Adopting…' : 'Adopt this declaration'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * What the last attempt did, in the grammar the refusal came in.
 *
 * The `refused` arm is the one that earns its own shape. §3's
 * disabled-with-reasons grammar is that a caller is told a fact about the
 * world, not asked to fix a field, and `NOT_DEPLOYABLE` is that code — a
 * message about a Target that already exists with a different adapter is not
 * something re-typing a value in this form can resolve.
 *
 * Exported for the reason {@link refusalOf} is: onboarding writes through the
 * same command and therefore meets the same three refusals, and it says them in
 * this markup rather than in a second copy that could drift out of the grammar.
 */
export function Outcome({ outcome }: { readonly outcome: SaveOutcome | null }) {
  if (outcome === null) return null;

  if (outcome.kind === 'saved') {
    return (
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-good/40 bg-good/10 p-3 text-sm text-good"
      >
        <CircleCheck aria-hidden="true" className="mt-0.5 size-4" />
        <div>
          <p className="font-medium">This installation was configured.</p>
          <p className="mt-0.5">
            {outcome.targets.length === 0
              ? 'It declares no Targets.'
              : `Targets reconciled, in rank order: ${outcome.targets.join(', ')}.`}
          </p>
        </div>
      </div>
    );
  }

  if (outcome.kind === 'refused') {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-border bg-secondary p-3 text-sm text-foreground"
      >
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
        <div>
          <p className="font-medium">
            This installation cannot take that manifest.
          </p>
          <p className="mt-0.5">{outcome.message}</p>
          <p className="mt-1 text-muted-foreground">
            Nothing was written. This is a fact about the installation, not a
            field to correct.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-terminal-destructive"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4" />
      <div>
        <p className="font-medium">
          {outcome.kind === 'invalid'
            ? 'This manifest was refused.'
            : 'That save did not happen.'}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap">{outcome.message}</p>
      </div>
    </div>
  );
}
