/**
 * Deploying a new App: one screen, already answered.
 *
 * §18 named the creation flow Source → Component → Place → Configure → Review,
 * and this screen still is that, in that order. What went away is the rail.
 * Stories 31 and 32 say what the sequence was *for* — "defaults carrying every
 * step", "corrections and configuration hidden behind progressive disclosure"
 * — and five screens with a Continue button under each turned out to be the
 * rendering that made every default look like a question. Four Continues to
 * accept four answers nobody disagreed with is not a short happy path; it is a
 * long one with the disagreement removed.
 *
 * So: pick a source, read what it resolved to, press Deploy. Every row states
 * the answer **and why it is the answer**, and every row that can be corrected
 * opens the correction in place, without losing sight of the rows that choice
 * decides.
 *
 * The reason this is honest now and would not have been before is
 * `inspectRepository`. The draft has always carried a `detection` block and
 * nothing could ever fill it, so every draft opened claiming to be a service
 * "until detection says otherwise" and detection never said. Choosing a
 * repository here runs the real §5 ladder over the real default branch, and
 * the kind, the scope, the build frontend and the ruled-out kinds are what it
 * found.
 */
import { AlertTriangle, Loader2, Rocket } from 'lucide-react';
import { type Dispatch, useRef, useState } from 'react';
import type {
  CreationDraftView,
  DraftAction,
} from '../../../../domain/creation-draft.ts';
import { command, type TransportFailure } from '../../../client.ts';
import { RepoPicker } from '../../../components/repo-picker.tsx';
import type { RepositoryOptionView, TargetOptionView } from '../../../model.ts';
import { Badge } from '../../../ui/badge.tsx';
import { Button } from '../../../ui/button.tsx';
import { Card, Eyebrow } from '../../../ui/card.tsx';
import { Field } from '../../../ui/field.tsx';
import { blockersFor, type Draft, draftReducer, ENTRIES } from './draft.ts';
import {
  Advanced,
  AUTH_NOTE,
  AUTHS,
  Choice,
  KIND_NOTE,
  KINDS,
  REACH_NOTE,
  REACHES,
  Row,
  TargetHealth,
  VesselRow,
} from './summary.tsx';

export function NewApp({
  initial,
  targets: initialTargets,
  repos,
  onCreated,
}: {
  initial: CreationDraftView;
  targets: readonly TargetOptionView[];
  repos: readonly RepositoryOptionView[];
  onCreated?: (app: { readonly id: string; readonly name: string }) => void;
}) {
  const [draft, setDraft] = useState(initial.draft);
  // Placement is derived from kind, reach and auth (§3), so the options are
  // only true for the draft they were resolved against. Correcting any of the
  // three re-resolves them; leaving them stale is how a `website` ends up
  // offered the candidates for a `service`.
  const [targets, setTargets] = useState(initialTargets);
  const [serverBlockers, setServerBlockers] = useState(initial.blockers);
  const [refusal, setRefusal] = useState<TransportFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const draftRef = useRef(initial.draft);
  const revisionRef = useRef(initial.revision);
  const saves = useRef(Promise.resolve());
  const pendingSaves = useRef(0);
  const saveFailed = useRef(false);

  const candidateIds = targets
    .filter((target) => target.candidate)
    .map((target) => target.targetId);
  const localBlockers = blockersFor(draft, candidateIds);
  const blockers = [
    ...localBlockers,
    ...serverBlockers.filter(
      (server) => !localBlockers.some((local) => local.code === server.code),
    ),
  ];
  const target = targets.find((option) => option.targetId === draft.targetId);

  const dispatch: Dispatch<DraftAction> = (action) => {
    const previous = draftRef.current;
    const next = draftReducer(previous, action);
    draftRef.current = next;
    setDraft(next);
    // Compared rather than keyed off the action type: `entry` and `detect`
    // change the kind too, and an enumeration here would drift the first time a
    // new action moves one of the three.
    if (
      next.kind !== previous.kind ||
      next.reach !== previous.reach ||
      next.auth !== previous.auth
    ) {
      void command('listTargets', {
        kind: next.kind,
        reach: next.reach,
        auth: next.auth,
      }).then((result) => {
        // Only the newest answer counts: a slower earlier read must not
        // overwrite the options for the draft as it stands now.
        if (result.ok && draftRef.current === next)
          setTargets(result.value.options);
      });
    }
    pendingSaves.current += 1;
    setSaving(true);
    saves.current = saves.current
      .then(async () => {
        const result = await command('saveCreationDraft', {
          id: initial.id,
          revision: revisionRef.current,
          draft: next,
        });
        if (!result.ok) {
          saveFailed.current = true;
          setRefusal(result.failure);
          return;
        }
        revisionRef.current = result.value.revision;
        saveFailed.current = false;
        setServerBlockers(result.value.blockers);
        setRefusal(null);
      })
      .catch((cause: unknown) => {
        saveFailed.current = true;
        setRefusal({
          code: 'MALFORMED_REQUEST',
          message:
            cause instanceof Error ? cause.message : 'the draft could not save',
        });
      })
      .finally(() => {
        pendingSaves.current -= 1;
        setSaving(pendingSaves.current > 0);
      });
  };

  /**
   * Choosing a repository is choosing everything the repository implies.
   *
   * One read of the real default branch, through the same ladder that writes
   * `spindrift.yaml`. Failing to detect is not failing to select — the repo is
   * still the source, the kind is still correctable, and the sentence says
   * which of the two happened.
   */
  const selectRepo = async (fullName: string, url: string) => {
    dispatch({ type: 'repo', fullName, url });
    setDetecting(true);
    setDetectionError(null);
    try {
      const result = await command('inspectRepository', { fullName });
      if (!result.ok) {
        setDetectionError(result.failure.message);
        return;
      }
      const found = result.value.scopes.find(
        (scope) => scope.outcome === 'detected',
      );
      if (found === undefined || found.outcome !== 'detected') {
        setDetectionError(
          `Spindrift found nothing it knows how to build in ${fullName}. Pick the kind yourself, or add a spindrift.yaml.`,
        );
        return;
      }
      dispatch({
        type: 'detect',
        scope: found.scope,
        kind: found.kind,
        reason: found.reason,
        unavailable: found.unavailable,
      });
    } catch (cause) {
      setDetectionError(
        cause instanceof Error ? cause.message : 'the repository was not read',
      );
    } finally {
      setDetecting(false);
    }
  };

  /** The terminal act: revalidate and create under one database lock. */
  async function start() {
    setSubmitting(true);
    setRefusal(null);
    await saves.current;
    if (saveFailed.current) {
      setSubmitting(false);
      return;
    }
    const result = await command('completeCreationDraft', {
      id: initial.id,
      revision: revisionRef.current,
    });
    if (!result.ok) {
      setRefusal(result.failure);
      setSubmitting(false);
      return;
    }
    setServerBlockers(result.value.draft.blockers);
    if (result.value.app === null) {
      setSubmitting(false);
      return;
    }
    onCreated?.({
      id: result.value.app.appId,
      name: result.value.app.name,
    });
    setSubmitting(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-[760px] flex-col gap-5 px-5 py-6">
      <header>
        <Eyebrow>New App</Eyebrow>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          {draft.source.kind === 'repo'
            ? `Deploy from ${draft.source.repo}`
            : 'Deploy an upload'}
        </h1>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Everything below already has an answer. Read down, correct what is
          wrong, and start the first Build.
        </p>
      </header>

      <Card>
        <SourceRow
          draft={draft}
          dispatch={dispatch}
          repos={repos}
          detecting={detecting}
          detectionError={detectionError}
          onSelectRepo={selectRepo}
        />

        <Row
          label="Component"
          unsettled={detectionError !== null}
          value={`${draft.componentName} · ${draft.kind}`}
          why={draft.detection.reason}
          tone={
            draft.kind === draft.detection.kind ? null : (
              <Badge tone="warning">corrected</Badge>
            )
          }
        >
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                name="appName"
                label="App name"
                value={draft.appName}
                onChange={(event) =>
                  dispatch({
                    type: 'field',
                    field: 'appName',
                    value: event.target.value,
                  })
                }
                hint="Lowercase DNS label — it appears in the canonical hostname."
              />
              <Field
                name="componentName"
                label="Component name"
                value={draft.componentName}
                onChange={(event) =>
                  dispatch({
                    type: 'field',
                    field: 'componentName',
                    value: event.target.value,
                  })
                }
              />
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {KINDS.map((kind) => {
                const reason = draft.detection.unavailable[kind];
                return (
                  <Choice
                    key={kind}
                    selected={draft.kind === kind}
                    disabled={reason !== undefined}
                    title={kind}
                    note={reason ?? KIND_NOTE[kind]}
                    onClick={() => dispatch({ type: 'kind', kind })}
                  />
                );
              })}
            </div>
          </div>
        </Row>

        <Row
          label="Target"
          unsettled={target === undefined || !target.candidate}
          value={target?.name ?? 'none'}
          tone={
            target === undefined ? null : (
              <TargetHealth healthy={target.candidate} />
            )
          }
          why={
            target === undefined
              ? 'No Target is selected.'
              : target.candidate
                ? `${target.adapter} · ${target.artifactType ?? 'no artifact shape'} · rank ${target.rank}`
                : target.reasons.join(', ')
          }
        >
          <div className="flex flex-col gap-2">
            <Eyebrow>Targets, in admin rank order</Eyebrow>
            {targets.map((option) => (
              <Choice
                key={option.targetId}
                selected={draft.targetId === option.targetId}
                disabled={!option.candidate}
                onClick={() =>
                  dispatch({ type: 'target', targetId: option.targetId })
                }
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-semibold">{option.name}</span>
                  <Badge tone="idle">{option.adapter}</Badge>
                  {option.candidate && option.artifactType ? (
                    <Badge tone="accent">{option.artifactType}</Badge>
                  ) : null}
                  <span className="ml-auto font-mono text-xs text-muted-foreground">
                    rank {option.rank}
                  </span>
                </div>
                {option.candidate ? (
                  <span
                    className={
                      option.canonical === null
                        ? 'text-xs text-subtle'
                        : 'font-mono text-xs text-muted-foreground'
                    }
                  >
                    {/* §9: `null` means this adapter names its own workloads
                        — say so rather than showing a suffix core will never
                        mint. */}
                    {option.canonical ?? 'platform names its own'}
                  </span>
                ) : (
                  <ul className="flex flex-col gap-0.5">
                    {option.reasons.map((reason, index) => (
                      <li key={reason} className="text-xs text-destructive">
                        <span className="font-mono font-semibold">
                          {reason}
                        </span>
                        {option.detail[index]
                          ? ` — ${option.detail[index]}`
                          : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </Choice>
            ))}
          </div>
        </Row>

        <Row
          label="URL"
          value={
            target === undefined
              ? 'pending a Target'
              : // §9: `null` is not "pending" — it is `cloudrun`/`static`
                // reporting their own address back after deploy, which this
                // step cannot show early because nothing has deployed yet.
                (target.canonical ?? 'platform names its own')
          }
        />

        <Row label="Reach" value={draft.reach} why={REACH_NOTE[draft.reach]}>
          <div className="grid gap-2 sm:grid-cols-3">
            {REACHES.map((reach) => (
              <Choice
                key={reach}
                selected={draft.reach === reach}
                title={reach}
                note={REACH_NOTE[reach]}
                onClick={() => dispatch({ type: 'reach', reach })}
              />
            ))}
          </div>
        </Row>

        {/*
          Offered separately because it is a separate fact, and hidden at
          `reach: none` because there is no route to put a filter on — the same
          refusal validation makes, stated by not asking.
        */}
        {draft.reach !== 'none' && (
          <Row label="Auth" value={draft.auth} why={AUTH_NOTE[draft.auth]}>
            <div className="grid gap-2 sm:grid-cols-2">
              {AUTHS.map((auth) => (
                <Choice
                  key={auth}
                  selected={draft.auth === auth}
                  title={auth}
                  note={AUTH_NOTE[auth]}
                  onClick={() => dispatch({ type: 'auth', auth })}
                />
              ))}
            </div>
          </Row>
        )}

        <VesselRow
          name={draft.vessel.name}
          note={draft.vessel.note}
          ready={draft.vessel.ready}
        />

        <Advanced
          title={`Config (${draft.config.length} ${draft.config.length === 1 ? 'key' : 'keys'})`}
        >
          {draft.config.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No configuration keys yet. A config change produces a new Deploy.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {draft.config.map((key) => (
                <div
                  key={key.name}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <span className="font-mono text-sm">{key.name}</span>
                  <Badge
                    tone={key.supplied ? 'success' : 'warning'}
                    className="ml-auto"
                  >
                    {key.supplied ? 'supplied' : 'needs a value'}
                  </Badge>
                </div>
              ))}
              <p className="text-xs text-muted-foreground">
                Values are write-only. Spindrift stores one secret per variable
                and never reads one back — including here, which is why a key
                left empty cannot be filled in from this screen later.
              </p>
            </div>
          )}
        </Advanced>
      </Card>

      {blockers.length > 0 ? (
        <div className="flex flex-col gap-2">
          {blockers.map((blocker) => (
            <div
              key={blocker.code}
              className="flex items-start gap-2.5 rounded-md border border-destructive bg-destructive-soft px-3 py-2.5"
            >
              <AlertTriangle
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-destructive"
              />
              <div>
                <p className="text-sm font-semibold text-destructive">
                  {blocker.title}
                </p>
                <p className="text-xs text-subtle">{blocker.remediation}</p>
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            Nothing has been created. This draft is kept — clear the item above
            and come back to it.
          </p>
        </div>
      ) : null}

      {refusal ? <Refusal failure={refusal} /> : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          disabled={blockers.length > 0 || submitting || saving || detecting}
          onClick={start}
        >
          <Rocket aria-hidden="true" />
          {submitting ? 'Creating…' : saving ? 'Saving…' : 'Deploy'}
        </Button>
        <p className="text-xs text-muted-foreground">
          {blockers.length > 0
            ? 'Spindrift stops before Build #1.'
            : 'Creating the App locks its vessel and dispatches the first Build.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Source, which is the one row that is genuinely a question.
 *
 * Everything below it is downstream of this answer, which is why it is first
 * and why choosing a repository detects immediately rather than waiting for a
 * Continue: the rows underneath are wrong until it has.
 */
function SourceRow({
  draft,
  dispatch,
  repos,
  detecting,
  detectionError,
  onSelectRepo,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  repos: readonly RepositoryOptionView[];
  detecting: boolean;
  detectionError: string | null;
  onSelectRepo: (fullName: string, url: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // No bucket named: which bucket sources stage to is installation
      // configuration and lives on the Storage screen.
      const response = await fetch('/internal/upload', {
        method: 'POST',
        body: formData,
      });
      const res = await response.json();
      if (res.ok) {
        dispatch({
          type: 'archive',
          filename: res.value.filename,
          digest: res.value.digest,
          location: res.value.location,
        });
      } else {
        setUploadError(res.failure?.message || 'Archive upload failed');
      }
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error ? err.message : 'Network error during upload',
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <Row
      label="Source"
      unsettled={draft.source.kind === 'archive' && !draft.source.location}
      value={
        draft.source.kind === 'repo'
          ? `${draft.source.repo} · ${draft.source.subpath}`
          : draft.source.filename
      }
      tone={
        detecting ? (
          <Badge tone="idle">
            <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            reading
          </Badge>
        ) : null
      }
      why={
        detectionError ??
        (draft.source.kind === 'archive' && !draft.source.location
          ? 'Not staged yet.'
          : undefined)
      }
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {ENTRIES.map((entry) => (
            <Choice
              key={entry.id}
              selected={draft.entry === entry.id}
              title={entry.label}
              note={entry.note}
              onClick={() => dispatch({ type: 'entry', entry: entry.id })}
            />
          ))}
        </div>

        {draft.source.kind === 'repo' ? (
          <div className="flex flex-col gap-3">
            <RepoPicker
              repos={repos}
              selected={draft.source.repo}
              onSelect={onSelectRepo}
            />
            <Field
              name="subpath"
              label="Root directory"
              value={draft.source.subpath}
              onChange={(event) =>
                dispatch({ type: 'subpath', subpath: event.target.value })
              }
              hint="Named, never searched — Spindrift does not roam the tree. Detection filled this in."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-border p-4 transition-colors hover:border-primary">
              <span className="text-sm font-medium text-foreground">
                {uploading
                  ? 'Uploading archive…'
                  : 'Choose or drop a zip/tar archive'}
              </span>
              <span className="mt-0.5 text-xs text-muted-foreground">
                Accepts .zip, .tar.gz, .tgz
              </span>
              <input
                type="file"
                accept=".zip,.tar.gz,.tgz,.tar"
                disabled={uploading}
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
            {draft.source.location ? (
              <p className="font-mono text-[11px] text-success">
                staged: {draft.source.location}
              </p>
            ) : null}
            {uploadError ? (
              <p className="text-xs text-destructive">{uploadError}</p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              An archive is not read the way a repository is — nothing has
              looked inside it, so pick the kind under Component yourself.
            </p>
          </div>
        )}
      </div>
    </Row>
  );
}

/**
 * What the server said when it would not do it.
 *
 * The code is shown alongside the sentence because it is a closed vocabulary
 * and therefore searchable — the same reason §6 keeps its eight failure reasons
 * rather than writing friendlier prose.
 */
function Refusal({ failure }: { failure: TransportFailure }) {
  return (
    <div className="rounded-md border border-destructive bg-destructive-soft px-3 py-2.5">
      <p className="font-mono text-xs font-semibold text-destructive">
        {failure.code}
      </p>
      <p className="mt-0.5 text-sm text-subtle">{failure.message}</p>
      {failure.issues?.length ? (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {failure.issues.map((issue) => (
            <li key={issue.path} className="font-mono text-xs text-subtle">
              {issue.path}: {issue.message}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
