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
import { CircleAlert, CircleCheck, RotateCcw, Sliders } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { TransportFailure } from '../../client.ts';
import { command } from '../../client.ts';
import { manifestFields, manifestIssues } from '../../forms/manifest.ts';
import type { FieldErrors } from '../../forms/render.tsx';
import { SchemaFields } from '../../forms/render.tsx';
import type { FormField } from '../../forms/schema.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, CardHeader, CardTitle } from '../../ui/card.tsx';

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

  const load = useCallback(async () => {
    const result = await command('getInstallationManifest', {});
    if (result.ok) {
      setDocument(result.value.manifest);
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
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Loading this installation…
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <InstallationSettingsView
      fields={manifestFields()}
      document={document}
      errors={errors}
      outcome={outcome}
      saving={saving}
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
    />
  );
}

/** A refusal, kept in the three kinds the command actually draws. */
function refusalOf(failure: TransportFailure): SaveOutcome {
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
function issuesOf(failure: TransportFailure): FieldErrors {
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
  onChange,
  onSave,
  onReload,
}: {
  readonly fields: readonly FormField[];
  readonly document: unknown;
  readonly errors: FieldErrors;
  readonly outcome: SaveOutcome | null;
  readonly saving: boolean;
  onChange(document: unknown): void;
  onSave(): void;
  onReload(): void;
}) {
  const form = { document, errors, disabled: saving, onChange };
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
      <Card>
        <CardHeader>
          <Sliders aria-hidden="true" className="mt-0.5 size-4 text-subtle" />
          <div>
            <CardTitle>Installation manifest</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Everything that names this installation. Saving writes the whole
              document and reconciles the Targets it declares.
            </p>
          </div>
        </CardHeader>
        {plain.length === 0 ? null : (
          <CardContent>
            <SchemaFields fields={plain} at={[]} form={form} />
          </CardContent>
        )}
      </Card>

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
 * What the last attempt did, in the grammar the refusal came in.
 *
 * The `refused` arm is the one that earns its own shape. §3's
 * disabled-with-reasons grammar is that a caller is told a fact about the
 * world, not asked to fix a field, and `NOT_DEPLOYABLE` is that code — a
 * message about a Target that already exists with a different adapter is not
 * something re-typing a value in this form can resolve.
 */
function Outcome({ outcome }: { readonly outcome: SaveOutcome | null }) {
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
