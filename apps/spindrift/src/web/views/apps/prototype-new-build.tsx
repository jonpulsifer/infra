/**
 * PROTOTYPE — three shapes of "start a Build from new bytes", on the App page.
 *
 * Throwaway. Delete this file and the `prototype` prop on {@link Workspace}
 * when one of these is folded in for real.
 *
 * The question: an operator holding an archive has no way to give it to an App
 * that already exists. `/internal/upload` is reached only from the create flow,
 * and `deployApp` already refuses with sentences naming an act the UI does not
 * offer — "upload an archive for this Component", "upload it again to stage it
 * in the depot" (`commands/apps/deploy.ts:208`).
 *
 *   A  the header verb learns its source   — `Rebuild ▾`, minimal, verb-first
 *   B  a band on the Releases tab          — contextual, history-first
 *   C  a control on each Component row     — granular, and the only one whose
 *                                            shape matches the command's, since
 *                                            a Build is per (component, target)
 *
 * Nothing here writes. `onStage` is handed the file and returns what
 * `/internal/upload` returns; the prototype server answers it with a digest so
 * the confirm step has something true-shaped to show.
 */
import { ChevronDown, Upload } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { ComponentView } from '../../model.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';

export type PrototypeVariant = 'A' | 'B' | 'C';

/** What `/internal/upload` hands back, which is all any of these needs. */
export interface StagedUpload {
  readonly digest: string;
  readonly location: string;
  readonly filename: string;
  readonly size: number;
}

export interface PrototypeNewBuild {
  readonly variant: PrototypeVariant;
  /**
   * Whether this App's source is an uploaded archive.
   *
   * The live `WorkspaceView` does **not** carry this. `getAppWorkspace` reads
   * `app.sourceKind` and spends it on nulling `buildRoute` and `autoDeploy`
   * (`commands/apps/workspace.ts:399`), so the browser cannot tell an archive
   * App from a repo App whose route is unset. Every variant below needs the
   * distinction, so folding any of them in means putting it on the view.
   */
  readonly archiveSourced: boolean;
  readonly onStage: (file: File) => Promise<StagedUpload>;
}

/** §4's two arms, which the command cannot infer and so must be asked. */
type Contents = 'artifact' | 'source';

// ---------------------------------------------------------------------------
// the shared act, once — each variant differs in where it is reached from
// ---------------------------------------------------------------------------

function UploadPanel({
  component,
  archiveSourced,
  onStage,
  onDone,
}: {
  component: string;
  archiveSourced: boolean;
  onStage: (file: File) => Promise<StagedUpload>;
  onDone?: () => void;
}) {
  const [staged, setStaged] = useState<StagedUpload | null>(null);
  const [contents, setContents] = useState<Contents>(
    archiveSourced ? 'artifact' : 'source',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      setStaged(await onStage(file));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'Staging failed');
    } finally {
      setBusy(false);
    }
  };

  if (staged) {
    return (
      <div className="grid gap-3 text-sm">
        <div className="grid gap-1">
          <span className="text-muted-foreground text-xs">
            Staged — the digest is over the converted bytes, so a ZIP names the
            tarball the builders fetch
          </span>
          <span className="font-mono text-xs break-all">{staged.digest}</span>
          <span className="text-muted-foreground text-xs">
            {staged.filename} · {(staged.size / 1024).toFixed(1)} KiB
          </span>
        </div>
        <fieldset className="grid gap-2">
          <legend className="text-muted-foreground text-xs">
            What is in it
          </legend>
          {(
            [
              [
                'artifact',
                'Finished output',
                'Recorded, not built. The Build is born SUCCEEDED and this digest stands as the artifact.',
              ],
              [
                'source',
                'Source to build',
                'Staged PENDING for the build route to run, exactly as a repo would.',
              ],
            ] as const
          ).map(([value, label, why]) => (
            <label
              key={value}
              className="flex cursor-pointer items-start gap-2 rounded-sm border border-border p-2"
            >
              <input
                type="radio"
                name={`contents-${component}`}
                checked={contents === value}
                onChange={() => setContents(value)}
                className="mt-1"
              />
              <span className="grid gap-0.5">
                <span className="font-medium">{label}</span>
                <span className="text-muted-foreground text-xs">{why}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="flex gap-2">
          <Button size="sm" onClick={onDone}>
            {contents === 'artifact' ? 'Record build' : 'Build'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setStaged(null);
              setError(null);
            }}
          >
            Pick another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: prototype drop zone */}
      <div
        className="grid place-items-center gap-1 rounded-sm border border-border border-dashed p-5 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          void take(event.dataTransfer.files[0]);
        }}
      >
        <Upload aria-hidden="true" className="size-4 text-muted-foreground" />
        <span className="text-sm">
          {busy ? 'Staging…' : 'Drop a .zip or .tar.gz'}
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          Choose a file
        </Button>
        <input
          ref={input}
          type="file"
          accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
          className="hidden"
          onChange={(event) => void take(event.target.files?.[0])}
        />
      </div>
      {error ? <span className="text-destructive text-xs">{error}</span> : null}
      <span className="text-muted-foreground text-xs">
        Goes to <span className="font-mono">{component}</span> on its placed
        Target. A ZIP is transcoded here; anything else is refused with a
        sentence naming what arrived.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A — the header verb learns its source
// ---------------------------------------------------------------------------

export function VariantARebuild({
  prototype,
  component,
  onRebuild,
  deploying,
}: {
  prototype: PrototypeNewBuild;
  component: string;
  onRebuild?: () => void;
  deploying: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);

  // An archive App has no other meaning for the verb: rebuilding from a bundle
  // that cannot be fetched again is the refusal `deployApp` already writes. So
  // there is nothing to choose between, and no menu is offered.
  if (prototype.archiveSourced) {
    return (
      <div className="relative">
        <Button
          variant="outline"
          disabled={deploying}
          onClick={() => setSheet((was) => !was)}
        >
          Rebuild…
        </Button>
        {sheet ? (
          <Card className="absolute top-full right-0 z-30 mt-2 w-96">
            <CardContent className="pt-4">
              <UploadPanel
                component={component}
                archiveSourced
                onStage={prototype.onStage}
                onDone={() => setSheet(false)}
              />
            </CardContent>
          </Card>
        ) : null}
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="inline-flex">
        <Button
          variant="outline"
          className="rounded-r-none"
          onClick={onRebuild}
          disabled={deploying}
        >
          Rebuild
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Rebuild from something else"
          className="-ml-px w-7 rounded-l-none"
          disabled={deploying}
          onClick={() => setOpen((was) => !was)}
        >
          <ChevronDown aria-hidden="true" />
        </Button>
      </div>
      {open ? (
        <Card className="absolute top-full right-0 z-30 mt-2 w-96">
          <CardContent className="grid gap-3 pt-4">
            <button
              type="button"
              className="rounded-sm border border-border p-2 text-left text-sm hover:border-primary"
              onClick={() => {
                setOpen(false);
                onRebuild?.();
              }}
            >
              <span className="block font-medium">From HEAD</span>
              <span className="block text-muted-foreground text-xs">
                Fetch the repo again at its current commit
              </span>
            </button>
            <div className="grid gap-2">
              <Eyebrow>From an archive</Eyebrow>
              <UploadPanel
                component={component}
                archiveSourced={false}
                onStage={prototype.onStage}
                onDone={() => setOpen(false)}
              />
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// B — a band at the top of Releases
// ---------------------------------------------------------------------------

export function VariantBReleasesBand({
  prototype,
  component,
}: {
  prototype: PrototypeNewBuild;
  component: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardContent className="grid gap-3 pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-0.5">
            <span className="font-medium text-sm">
              {prototype.archiveSourced
                ? 'This App is deployed from an uploaded archive'
                : 'Start a release from bytes instead of the repo'}
            </span>
            <span className="text-muted-foreground text-xs">
              {prototype.archiveSourced
                ? 'Its bundle cannot be fetched again, so a new release means new bytes.'
                : 'For a build the repo cannot produce — a vendored bundle, or output built elsewhere.'}
            </span>
          </div>
          <Button size="sm" onClick={() => setOpen((was) => !was)}>
            {open ? 'Cancel' : 'Upload an archive'}
          </Button>
        </div>
        {open ? (
          <UploadPanel
            component={component}
            archiveSourced={prototype.archiveSourced}
            onStage={prototype.onStage}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// C — per Component, which is the shape the command actually has
// ---------------------------------------------------------------------------

export function VariantCComponentAction({
  prototype,
  component,
}: {
  prototype: PrototypeNewBuild;
  component: ComponentView;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen((was) => !was)}
        aria-label={`Upload an archive for ${component.name}`}
      >
        <Upload aria-hidden="true" />
        Upload
      </Button>
      {open ? (
        <Card className="absolute top-full right-0 z-30 mt-2 w-96 text-left">
          <CardContent className="grid gap-3 pt-4">
            <div className="flex items-center gap-2">
              <Badge tone="accent">{component.kind}</Badge>
              <span className="font-medium text-sm">{component.name}</span>
            </div>
            <UploadPanel
              component={component.name}
              archiveSourced={prototype.archiveSourced}
              onStage={prototype.onStage}
              onDone={() => setOpen(false)}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// the switcher — visibly not part of what is being judged
// ---------------------------------------------------------------------------

const VARIANTS: readonly {
  id: PrototypeVariant;
  name: string;
  where: string;
}[] = [
  { id: 'A', name: 'Header verb', where: 'Rebuild ▾ beside Deploy' },
  { id: 'B', name: 'Releases band', where: 'top of the Releases tab' },
  { id: 'C', name: 'Component row', where: 'per Component, beside reach' },
];

export function PrototypeSwitcher({
  current,
  onSelect,
  archiveSourced,
  onToggleSource,
}: {
  current: PrototypeVariant;
  onSelect: (variant: PrototypeVariant) => void;
  archiveSourced: boolean;
  onToggleSource: () => void;
}): ReactNode {
  const step = (by: number) => {
    const at = VARIANTS.findIndex((variant) => variant.id === current);
    const next = VARIANTS[(at + by + VARIANTS.length) % VARIANTS.length];
    if (next) onSelect(next.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'ArrowLeft') step(-1);
      if (event.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const shown = VARIANTS.find((variant) => variant.id === current);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-foreground px-1.5 py-1 text-background shadow-lg">
        <button
          type="button"
          aria-label="Previous variant"
          className="rounded-full px-2.5 py-1 hover:bg-background/20"
          onClick={() => step(-1)}
        >
          ←
        </button>
        <span className="px-2 font-mono text-xs">
          <b className="text-accent-foreground">{current}</b> — {shown?.name}
          <span className="opacity-60"> · {shown?.where}</span>
        </span>
        <button
          type="button"
          aria-label="Next variant"
          className="rounded-full px-2.5 py-1 hover:bg-background/20"
          onClick={() => step(1)}
        >
          →
        </button>
        <button
          type="button"
          className="ml-1 rounded-full bg-background/20 px-2.5 py-1 font-mono text-xs hover:bg-background/30"
          onClick={onToggleSource}
        >
          source: {archiveSourced ? 'archive' : 'repo'}
        </button>
      </div>
    </div>
  );
}
