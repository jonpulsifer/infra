/**
 * Giving one Component new bytes (§4, §5).
 *
 * `deployApp` has always refused an archive App's Component with a sentence
 * naming the remedy — "upload an archive for this Component", "upload it again
 * to stage it in the depot" (`commands/apps/deploy.ts`) — and until this
 * control existed the remedy was reachable only by creating a *new* App, since
 * `/internal/upload` was called from the creation flow and nowhere else. A
 * refusal that names an act the screen does not offer is the failure mode a
 * green suite is worst at catching, which is the whole reason this is here.
 *
 * **It lives on the Component row, not on the App.** `uploadArchive` resolves
 * on `(componentId, targetId)` — §3 puts resolution before the build and has it
 * output "placement plus artifact shape", so a Build's key includes the shape
 * and there is no App-level act that could stand in for this one. An App with
 * three Components has three separate answers to "which one gets these bytes",
 * and a control in the header would have to invent a fourth question to ask.
 *
 * **Offered only where the Component is placed.** `serving` is every
 * (Component, Target) pair still standing; with none of them there is no Target
 * to resolve a shape against, and a first placement is `deployApp`'s to write
 * rather than this one's — which is exactly what the refusal says. Where a move
 * left two pairs standing, the Target is asked rather than guessed.
 *
 * Two steps, because the second question cannot be inferred: staging returns a
 * digest, and only then is §4's fork — *finished output* versus *source* —
 * answerable. The default follows the App: an archive App's uploads have always
 * been output it built elsewhere, a repo App reaching for this is vendoring
 * source it cannot fetch.
 */
import { Upload } from 'lucide-react';
import { useId, useState } from 'react';
import type { ComponentView } from '../../../commands/views.ts';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';

/** What `/internal/upload` returns, which is the digest and where it went. */
export interface StagedUpload {
  readonly digest: string;
  readonly location: string;
  readonly filename: string;
  readonly size: number;
}

/** §4's two arms. Neither is inferable from the bytes, so it is asked. */
export type ArchiveContents = 'artifact' | 'source';

export interface UploadRequest {
  readonly componentId: string;
  readonly targetId: string;
  readonly bundleDigest: string;
  readonly location: string;
  readonly contents: ArchiveContents;
}

export type StageArchive = (file: File) => Promise<StagedUpload>;
export type SubmitUpload = (
  request: UploadRequest,
) => Promise<{ readonly ok: true } | { readonly ok: false; message: string }>;

export function ComponentUploadButton({
  component,
  archiveSourced,
  onStage,
  onSubmit,
}: {
  readonly component: ComponentView;
  readonly archiveSourced: boolean;
  readonly onStage: StageArchive;
  readonly onSubmit: SubmitUpload;
}) {
  const [open, setOpen] = useState(false);
  const serving = component.serving ?? [];

  // Nothing to resolve a shape against. The act that gives this Component its
  // first Target is Deploy, and offering an upload here would collect bytes
  // `uploadArchive` has nowhere to put.
  if (serving.length === 0) return null;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Upload an archive for ${component.name}`}
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Upload aria-hidden="true" />
        Upload
      </Button>
      {open ? (
        <Card className="absolute top-full right-0 z-30 mt-2 w-[22rem] text-left">
          <CardContent className="pt-4">
            <UploadForm
              component={component}
              archiveSourced={archiveSourced}
              onStage={onStage}
              onSubmit={onSubmit}
              onDone={() => setOpen(false)}
            />
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

function UploadForm({
  component,
  archiveSourced,
  onStage,
  onSubmit,
  onDone,
}: {
  readonly component: ComponentView;
  readonly archiveSourced: boolean;
  readonly onStage: StageArchive;
  readonly onSubmit: SubmitUpload;
  readonly onDone: () => void;
}) {
  const serving = component.serving ?? [];
  const [staged, setStaged] = useState<StagedUpload | null>(null);
  const [contents, setContents] = useState<ArchiveContents>(
    archiveSourced ? 'artifact' : 'source',
  );
  const [targetId, setTargetId] = useState(serving[0]?.targetId ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const group = useId();

  const take = async (chosen: File | undefined) => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      setStaged(await onStage(chosen));
    } catch (cause: unknown) {
      // The boundary's own sentence, unedited — it names what arrived.
      setError(cause instanceof Error ? cause.message : 'Staging failed');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!staged || targetId === '') return;
    setBusy(true);
    setError(null);
    const result = await onSubmit({
      componentId: component.id,
      targetId,
      bundleDigest: staged.digest,
      location: staged.location,
      contents,
    });
    setBusy(false);
    if (result.ok) onDone();
    else setError(result.message);
  };

  if (staged === null) {
    return (
      <div className="grid gap-2">
        {/*
          A label around the input rather than a div with a click handler: the
          file dialog then opens from a real control, so the keyboard and a
          screen reader reach it without the drag handlers having to pretend to
          be an activation they cannot be — there is no keyboard equivalent of
          a drop, and `role="button"` here would claim one.
        */}
        <label
          className="grid cursor-pointer place-items-center gap-1 rounded-sm border border-border border-dashed p-5 text-center focus-within:border-primary"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            void take(event.dataTransfer.files[0]);
          }}
        >
          <input
            type="file"
            accept=".zip,.tar.gz,.tgz,application/zip,application/gzip"
            className="sr-only"
            disabled={busy}
            onChange={(event) => void take(event.target.files?.[0])}
          />
          <Upload aria-hidden="true" className="size-4 text-muted-foreground" />
          <span className="text-sm">
            {busy ? 'Staging…' : 'Choose a file, or drop one here'}
          </span>
          <span className="text-muted-foreground text-xs">.zip or .tar.gz</span>
        </label>
        {error ? (
          <p className="text-destructive text-xs">{error}</p>
        ) : (
          <p className="text-muted-foreground text-xs">
            A ZIP is converted to a gzipped tar here, so the digest names the
            bundle the builders fetch. Anything else is refused.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="grid gap-3 text-sm">
      <div className="grid gap-0.5">
        <span className="font-mono text-xs break-all">{staged.digest}</span>
        <span className="text-muted-foreground text-xs">
          {staged.filename} · {(staged.size / 1024).toFixed(1)} KiB
        </span>
      </div>

      {/* Asked only where a move left two pairs standing. */}
      {serving.length > 1 ? (
        <label className="grid gap-1">
          <span className="text-muted-foreground text-xs">Target</span>
          <select
            className="rounded-sm border border-border bg-card p-1.5 text-sm"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
          >
            {serving.map((pair) => (
              <option key={pair.targetId} value={pair.targetId}>
                {pair.label}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      <fieldset className="grid gap-2">
        <legend className="text-muted-foreground text-xs">What is in it</legend>
        {(
          [
            [
              'artifact',
              'Finished output',
              'Recorded, not built — this digest becomes the artifact.',
            ],
            [
              'source',
              'Source to build',
              'Staged for the build route, exactly as a repo would be.',
            ],
          ] as const
        ).map(([value, label, why]) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-2 rounded-sm border border-border p-2"
          >
            <input
              type="radio"
              name={group}
              className="mt-1"
              checked={contents === value}
              onChange={() => setContents(value)}
            />
            <span className="grid gap-0.5">
              <span className="font-medium">{label}</span>
              <span className="text-muted-foreground text-xs">{why}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {error ? <p className="text-destructive text-xs">{error}</p> : null}

      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void submit()}>
          {busy
            ? 'Working…'
            : contents === 'artifact'
              ? 'Record build'
              : 'Build'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
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
