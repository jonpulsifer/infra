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
import { type Dispatch, useEffect, useRef, useState } from 'react';
import type {
  Blocker,
  CreationDraftView,
  DraftAction,
} from '../../../../domain/creation-draft.ts';
import {
  type ClientResult,
  command,
  type TransportFailure,
} from '../../../client.ts';
import {
  RepoPicker,
  type RepositoryChoice,
  repositoryChoices,
} from '../../../components/repo-picker.tsx';
import type {
  GrantedRepositoryView,
  RepositoryOptionView,
  TargetOptionView,
} from '../../../model.ts';
import { reportSessionExpired } from '../../../session-events.ts';
import { Badge } from '../../../ui/badge.tsx';
import { Button } from '../../../ui/button.tsx';
import { Card, Eyebrow } from '../../../ui/card.tsx';
import { Field } from '../../../ui/field.tsx';
import {
  type InspectedScope,
  inspection,
  mergeScopes,
  outcomeOf,
} from './detect.ts';
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

/**
 * What stands between a repository with several Apps in it and a Deploy.
 *
 * The draft names a directory from the moment it exists — the root — and
 * deploying that because nobody corrected it is the silent first-hit this
 * screen refuses to make. So while detection is offering more than one
 * candidate and the draft names none of them, there is a prerequisite to clear,
 * stated the way every other unmet prerequisite on this screen is.
 *
 * A directory the operator typed is an answer, however detection reads it, and
 * a repository detection could make nothing of leaves the assertion path open:
 * §5's ladder proposes, and story 32 keeps the escape hatch.
 */
function unchosenScope(
  draft: Draft,
  detected: readonly InspectedScope[],
  named: boolean,
): readonly Blocker[] {
  if (draft.source.kind !== 'repo' || named || detected.length < 2) return [];
  if (detected.some((scope) => scope.scope === draft.source.subpath)) return [];
  return [
    {
      code: 'SOURCE_UNAVAILABLE',
      title: `Nothing is chosen to deploy from ${draft.source.repo}.`,
      remediation: `Detection found ${detected.length} directories it knows how to build. Pick one under Source, or name another yourself.`,
    },
  ];
}

export function NewApp({
  initial,
  targets: initialTargets,
  repos,
  available,
  onCreated,
}: {
  initial: CreationDraftView;
  targets: readonly TargetOptionView[];
  /** Repositories Spindrift holds a row for. */
  repos: readonly RepositoryOptionView[];
  /** Repositories GitHub currently grants this installation. */
  available: readonly GrantedRepositoryView[];
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
  // Everything the last read said about this repository, unsummarized. The
  // wizard's job is to offer it, so it is kept as it arrived: dropping the
  // scopes detection could not make sense of would leave "why not here"
  // unanswerable, and dropping the ones it could would leave the screen picking.
  const [scopes, setScopes] = useState<readonly InspectedScope[] | null>(null);
  const scopesRef = useRef<readonly InspectedScope[]>([]);
  const draftRef = useRef(initial.draft);
  const revisionRef = useRef(initial.revision);
  const saves = useRef(Promise.resolve());
  const pendingSaves = useRef(0);
  const saveFailed = useRef(false);

  const candidateIds = targets
    .filter((target) => target.candidate)
    .map((target) => target.targetId);
  const detected = (scopes ?? []).filter(
    (scope) => scope.outcome === 'detected',
  );
  const unchosen = unchosenScope(
    draft,
    detected,
    draft.scopeByOperator === true,
  );
  // The sentence under Component is a statement about one directory, and the
  // draft can name another one — an edit that has not settled yet, or a
  // directory detection could make nothing of. Saying which is what keeps the
  // reason from reading as though it were about the path on screen.
  const readElsewhere =
    draft.source.kind === 'repo' &&
    draft.detection.scope !== undefined &&
    draft.detection.scope !== draft.source.subpath;
  const localBlockers = [...blockersFor(draft, candidateIds), ...unchosen];
  const blockers = [
    ...localBlockers,
    ...serverBlockers.filter(
      (server) => !localBlockers.some((local) => local.code === server.code),
    ),
  ];
  const target = targets.find((option) => option.targetId === draft.targetId);
  const choices = repositoryChoices(repos, available);

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
   * Read a repository and offer what is in it.
   *
   * One read of the real default branch, through the same ladder that writes
   * `spindrift.yaml`. Every directory it answered about is kept and shown, and
   * `outcomeOf` decides what — if anything — the draft may take from it.
   *
   * `scope` names one directory, which is what an edited subpath asks about —
   * §5's "named, never searched". Its answer replaces that directory's row and
   * leaves the rest of the list alone, so correcting a path does not throw away
   * the candidates beside it.
   *
   * Failing to read is not failing to select: the repo is still the source, the
   * kind is still correctable, and the sentence says which of the two happened.
   */
  const inspect = async (fullName: string, scope?: string) => {
    setDetecting(true);
    setDetectionError(null);
    try {
      const result = await command(
        'inspectRepository',
        inspection(fullName, scope),
      );
      if (!result.ok) {
        setDetectionError(result.failure.message);
        return;
      }
      const found = result.value.scopes;
      const merged =
        scope === undefined ? found : mergeScopes(scopesRef.current, found);
      scopesRef.current = merged;
      setScopes(merged);

      const outcome = outcomeOf(draftRef.current, {
        fullName,
        scope,
        found,
        merged,
      });
      if (outcome.act === 'detect') dispatch(outcome.action);
      if (outcome.act === 'refuse') setDetectionError(outcome.message);
    } catch (cause) {
      setDetectionError(
        cause instanceof Error ? cause.message : 'the repository was not read',
      );
    } finally {
      setDetecting(false);
    }
  };

  /** Selecting a repository reads it. Nothing is written until Deploy. */
  const selectRepo = (repo: RepositoryChoice) => {
    dispatch({
      type: 'repo',
      fullName: repo.fullName,
      url: repo.cloneUrl,
      connect: repo.state === 'grant-only',
    });
    scopesRef.current = [];
    setScopes(null);
    void inspect(repo.fullName);
  };

  const chooseScope = (scope: InspectedScope) => {
    if (scope.outcome !== 'detected') return;
    dispatch({
      type: 'detect',
      scope: scope.scope,
      kind: scope.kind,
      reason: scope.reason,
      unavailable: scope.unavailable,
    });
  };

  /** A settled subpath edit asks about the directory it now names. */
  const settleSubpath = () => {
    const source = draftRef.current.source;
    if (source.kind !== 'repo' || source.repo === '' || !source.subpath) return;
    void inspect(source.repo, source.subpath);
  };

  // Detection runs for the repository the draft opens on, before anybody
  // presses anything. A draft claims a kind from the moment it exists, and a
  // screen that renders that claim without ever asking is the screen this
  // whole flow was supposed to replace. Reading writes nothing, so the only
  // thing it costs a draft nobody finishes is one request — and `outcomeOf`
  // is what keeps a reopened draft reading rather than re-deciding.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    const source = initial.draft.source;
    if (source.kind !== 'repo' || source.repo === '') return;
    void inspect(source.repo);
  }, []);

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
          {draft.source.kind !== 'repo'
            ? 'Deploy an upload'
            : draft.source.repo === ''
              ? 'Deploy from a repository'
              : `Deploy from ${draft.source.repo}`}
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
          repos={choices}
          scopes={scopes}
          detecting={detecting}
          detectionError={detectionError}
          unchosen={unchosen.length > 0}
          onSelectRepo={selectRepo}
          onChooseScope={chooseScope}
          onSettleSubpath={settleSubpath}
        />

        <Row
          label="Component"
          unsettled={
            detectionError !== null || unchosen.length > 0 || readElsewhere
          }
          value={`${draft.componentName} · ${draft.kind}`}
          why={
            readElsewhere && draft.source.kind === 'repo'
              ? `${draft.detection.reason} — read in ${draft.detection.scope}, and the root directory now names ${draft.source.subpath}.`
              : draft.detection.reason
          }
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
          value={
            target === undefined ? 'none' : `${target.vessel}/${target.adapter}`
          }
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
                  <span className="text-sm font-semibold">{option.vessel}</span>
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

interface UploadValue {
  readonly digest: string;
  readonly location: string;
  readonly filename: string;
  readonly size: number;
}

/**
 * Archive upload, with byte progress.
 *
 * `fetch` has no cross-browser way to report how much of a request body has
 * gone out — the upload side of the streams `ReadableStream` request bodies
 * would need is not the broadly-supported half. `XMLHttpRequest.upload` has
 * carried this exact event since it was introduced, so this is the one
 * remaining reason the screen reaches for it instead of `client.ts`'s `fetch`
 * wrapper the rest of the app uses.
 */
function uploadArchive(
  file: File,
  onProgress: (percent: number) => void,
): Promise<ClientResult<UploadValue>> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/internal/upload');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.onload = () => {
      try {
        resolve(JSON.parse(xhr.responseText) as ClientResult<UploadValue>);
      } catch {
        reject(new Error('Upload response was not valid JSON'));
      }
    };
    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
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
  scopes,
  detecting,
  detectionError,
  unchosen,
  onSelectRepo,
  onChooseScope,
  onSettleSubpath,
}: {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
  repos: readonly RepositoryChoice[];
  /** What the last read said, or `null` before anything has been read. */
  scopes: readonly InspectedScope[] | null;
  detecting: boolean;
  detectionError: string | null;
  /** Detection is offering candidates and the draft names none of them. */
  unchosen: boolean;
  onSelectRepo: (repo: RepositoryChoice) => void;
  onChooseScope: (scope: InspectedScope) => void;
  onSettleSubpath: () => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);
    setUploadPercent(0);
    try {
      // No bucket named: which bucket sources stage to is installation
      // configuration and lives on the Storage screen.
      const res = await uploadArchive(file, setUploadPercent);
      if (res.ok) {
        dispatch({
          type: 'archive',
          filename: res.value.filename,
          digest: res.value.digest,
          location: res.value.location,
        });
      } else if (res.failure.code === 'UNAUTHENTICATED') {
        // The 24h session expired mid-upload. This row has nothing sensible
        // to render for that beyond the raw refusal — `App` (`app.tsx`) does,
        // by re-gating to sign-in.
        reportSessionExpired();
      } else {
        setUploadError(res.failure.message || 'Archive upload failed');
      }
    } catch (err: unknown) {
      setUploadError(
        err instanceof Error ? err.message : 'Network error during upload',
      );
    } finally {
      setUploading(false);
      setUploadPercent(null);
    }
  }

  return (
    <Row
      label="Source"
      // Opens itself on anything unresolved, because §3's grammar only works
      // when the alternatives are visible: a sentence about a directory
      // Spindrift could not build is unreadable while the list of directories
      // it did read is behind a disclosure.
      unsettled={
        draft.source.kind === 'repo'
          ? draft.source.repo === '' || unchosen || detectionError !== null
          : !draft.source.location
      }
      value={
        draft.source.kind !== 'repo'
          ? draft.source.filename
          : draft.source.repo === ''
            ? 'no repository chosen'
            : `${draft.source.repo} · ${draft.source.subpath}`
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
              selected={draft.source.repo === '' ? null : draft.source.repo}
              onSelect={onSelectRepo}
            />
            <ScopeChooser
              subpath={draft.source.subpath}
              scopes={scopes}
              onChoose={onChooseScope}
            />
            <Field
              name="subpath"
              label="Root directory"
              value={draft.source.subpath}
              onChange={(event) =>
                dispatch({ type: 'subpath', subpath: event.target.value })
              }
              // Settled rather than per-keystroke: the reason on screen is a
              // statement about one directory, and re-reading `apps/w` on the
              // way to `apps/web` would describe a directory nobody named.
              onBlur={onSettleSubpath}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onSettleSubpath();
              }}
              hint="Named, never searched — Spindrift does not roam the tree. Leave the field to read the directory it now names."
            />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <label className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-border p-4 transition-colors hover:border-primary">
              <span className="text-sm font-medium text-foreground">
                {uploading
                  ? `Uploading archive… ${uploadPercent ?? 0}%`
                  : 'Choose or drop a zip/tar archive'}
              </span>
              <span className="mt-0.5 text-xs text-muted-foreground">
                Accepts .zip, .tar.gz, .tgz
              </span>
              {uploading ? (
                <div className="mt-2 h-1 w-full max-w-56 overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-150 ease-out"
                    style={{ width: `${uploadPercent ?? 0}%` }}
                  />
                </div>
              ) : null}
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
 * Every directory the repository was read for, as a list to choose from.
 *
 * §5 says discovery "proposes a list of candidate directories for a human to
 * choose from", and this is that list rather than a summary of it. A directory
 * detection knows how to build is selectable and wears the kind and the
 * sentence behind it; one it does not is here too, disabled, wearing what it
 * found instead — §3's grammar, which only works if the alternatives are
 * visible. An empty list means nothing has been read yet, which is a different
 * thing from a repository with nothing in it.
 */
function ScopeChooser({
  subpath,
  scopes,
  onChoose,
}: {
  subpath: string;
  scopes: readonly InspectedScope[] | null;
  onChoose: (scope: InspectedScope) => void;
}) {
  if (scopes === null || scopes.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <Eyebrow>Directories Spindrift read</Eyebrow>
      <div className="grid gap-2 sm:grid-cols-2">
        {scopes.map((scope) => (
          <Choice
            key={scope.scope}
            selected={scope.outcome === 'detected' && scope.scope === subpath}
            disabled={scope.outcome !== 'detected'}
            title={scope.scope}
            note={
              scope.outcome === 'detected'
                ? `${scope.kind} — ${scope.reason}`
                : scope.detail
            }
            onClick={() => onChoose(scope)}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Choosing one detects that directory and names the Component after it.
        Nothing is picked for you when there is more than one.
      </p>
    </div>
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
