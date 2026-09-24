/**
 * The installation manifest editor, rendered from the manifest schema, since
 * keys leave and arrive. The row has no revision, so concurrent saves lose one
 * edit; each save re-reads it.
 */
import {
  CircleAlert,
  CircleCheck,
  Download,
  RotateCcw,
  Sliders,
  Upload,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TransportFailure } from '../../client.ts';
import { command } from '../../client.ts';
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
  /** A transport or session failure. */
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
    // Checked here so each issue reaches its field; the command validates
    // again and has the final say.
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
        // Re-read the stored row: another save may have come in between.
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
          <p className="text-sm text-destructive">{loadError}</p>
        </CardContent>
      </Card>
    );
  }

  if (document === undefined) {
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

/**
 * `INVALID_INPUT` has a field to fix, `NOT_DEPLOYABLE` is a fact about this
 * installation, and anything else is a transport failure. Onboarding shares it.
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
    // Issue paths start at the command input's `manifest` key; the form's
    // paths start inside the document.
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

      {/* Discovered values are unsaved edits until the manifest is saved. */}
      <DiscoveryPanel
        document={document}
        disabled={saving}
        onChange={onChange}
      />

      {/* Top-level scalar keys, outside any card. */}
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
              // A required object renders its keys under the card's title. An
              // optional one keeps its wrapper, where "not configured" is said.
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

      <div className="flex flex-wrap items-center gap-3">
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
        <DownloadInstallation disabled={saving} />
      </div>
    </form>
  );
}

/**
 * Downloads the stored document, not the form's unsaved edits. It is JSON,
 * which the restore below reads back as YAML.
 */
function DownloadInstallation({ disabled }: { readonly disabled: boolean }) {
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const download = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await command('getInstallationManifest', {});
      if (!result.ok) {
        setFailure(result.failure.message);
        return;
      }
      const manifest = result.value.manifest as {
        installation?: { name?: string };
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(result.value.manifest, null, 2)], {
          type: 'application/json',
        }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${manifest.installation?.name ?? 'installation'}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setFailure(
        cause instanceof Error
          ? cause.message
          : 'This installation could not be read.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => void download()}
      >
        <Download aria-hidden="true" />
        {busy ? 'Reading…' : 'Download this installation'}
      </Button>
      {failure === null ? null : (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}

/**
 * Sends the file's text for the server to parse. The input resets after each
 * attempt, since choosing the same file again fires no change event.
 */
export function RestoreInstallation({
  disabled,
  onRestored,
}: {
  readonly disabled: boolean;
  /** Called with every attempt's outcome. */
  onRestored(outcome: SaveOutcome): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const restore = async (file: File) => {
    setBusy(true);
    try {
      const result = await command('configureInstallation', {
        manifest: await file.text(),
      });
      onRestored(
        result.ok
          ? { kind: 'saved', targets: result.value.targets }
          : refusalOf(result.failure),
      );
    } catch (cause) {
      onRestored({
        kind: 'failed',
        message:
          cause instanceof Error
            ? cause.message
            : 'That file could not be restored.',
      });
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".json,.yaml,.yml,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) void restore(file);
        }}
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => input.current?.click()}
      >
        <Upload aria-hidden="true" />
        {busy ? 'Restoring…' : 'Restore from a file'}
      </Button>
    </>
  );
}

/**
 * The last attempt's outcome. Onboarding shares it, so both screens show a
 * refusal the same way.
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
      className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
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
