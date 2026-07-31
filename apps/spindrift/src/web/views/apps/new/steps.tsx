/**
 * The five steps, and the ledger that stays visible beside them.
 *
 * Each step renders one decision and states what the alternative would cost.
 * The shared grammar across three of them — Component's kinds, Place's Targets,
 * Review's blockers — is §3's: **a thing that does not apply stays listed,
 * disabled, and annotated with why**. That grammar is the reason "nowhere fits"
 * is a readable answer here rather than an empty list.
 */
import { AlertTriangle, Lock } from 'lucide-react';
import { type Dispatch, type ReactNode, useEffect, useState } from 'react';
import type {
  ComponentKind,
  Exposure,
} from '../../../../domain/desired-state.ts';
import { command } from '../../../client.ts';
import { RepoPicker } from '../../../components/repo-picker.tsx';
import type { RepositoryOptionView, TargetOptionView } from '../../../model.ts';
import { Badge } from '../../../ui/badge.tsx';
import { Card, CardContent, Eyebrow } from '../../../ui/card.tsx';
import { Field } from '../../../ui/field.tsx';
import { cn } from '../../../ui/utils.ts';
import {
  type Blocker,
  type Draft,
  type DraftAction,
  ENTRIES,
} from './draft.ts';

type StepProps = {
  draft: Draft;
  dispatch: Dispatch<DraftAction>;
};

/**
 * A selectable tile — the one affordance this flow chooses with.
 *
 * Every choice on every step is one of these, including the Target rows on
 * Place, which is why it takes `children` rather than only a note: they all
 * share §3's grammar, where an option that does not apply stays **on screen,
 * disabled, wearing its reason**, and giving Place its own button was how the
 * disabled styling drifted apart from the rest.
 */
function Choice({
  selected,
  disabled,
  title,
  note,
  onClick,
  children,
}: {
  selected: boolean;
  disabled?: boolean;
  title?: string;
  note?: string;
  onClick?: () => void;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex flex-col gap-1 rounded-md border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-primary bg-accent'
          : 'border-border bg-card hover:border-primary',
        disabled && 'cursor-not-allowed opacity-60 hover:border-border',
      )}
    >
      {title ? <span className="text-sm font-semibold">{title}</span> : null}
      {note ? (
        <span className="text-xs text-muted-foreground">{note}</span>
      ) : null}
      {children}
    </button>
  );
}

function StepHeading({
  index,
  label,
  children,
}: {
  index: number;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      <Eyebrow>
        0{index} · {label}
      </Eyebrow>
      <h2 className="mt-1 text-lg font-semibold tracking-tight">{children}</h2>
    </div>
  );
}

/**
 * Step 1 — Source.
 *
 * A connected repo and an uploaded archive enter the **same** detector (§4), so
 * the tiles differ in where the bytes come from and in nothing else. The repo
 * form asks for a root directory because §5 names the scope and never searches
 * for it.
 */
export function StepSource({
  draft,
  dispatch,
  repos,
}: StepProps & { repos: readonly RepositoryOptionView[] }) {
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [bucketName, setBucketName] = useState<string | null>(null);
  const [buckets, setBuckets] = useState<readonly string[] | null>(null);
  const [defaultBucket, setDefaultBucket] = useState<string | null>(null);
  const [customBucket, setCustomBucket] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [bucketLoadError, setBucketLoadError] = useState(false);
  const [testingWif, setTestingWif] = useState(false);
  const [wifStatus, setWifStatus] = useState<string | null>(null);

  const bucketsLoading = buckets === null && !bucketLoadError;
  const activeBucketName = bucketName ?? '';

  useEffect(() => {
    command('listSourceBuckets', {})
      .then((res) => {
        if (res.ok) {
          setBuckets(res.value.buckets);
          setDefaultBucket(res.value.defaultBucket);
          const selected =
            res.value.defaultBucket ?? res.value.buckets[0] ?? null;
          setBucketName(selected);
        } else {
          setBucketLoadError(true);
          setBuckets([]);
        }
      })
      .catch(() => {
        setBucketLoadError(true);
        setBuckets([]);
      });
  }, []);

  async function handleTestWif() {
    if (!activeBucketName.trim()) return;
    setTestingWif(true);
    setWifStatus(null);
    try {
      const res = await command('testBucketPermissions', {
        bucketName: activeBucketName.trim(),
      });
      if (res.ok) {
        setWifStatus(`✓ WIF permissions verified for ${res.value.location}`);
      } else {
        setWifStatus(`✗ WIF check failed: ${res.failure.message}`);
      }
    } catch {
      setWifStatus('Network error testing bucket permissions');
    } finally {
      setTestingWif(false);
    }
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setUploading(true);
    setUploadError(null);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const headers: Record<string, string> = {};
      if (activeBucketName.trim()) {
        headers['x-bucket'] = activeBucketName.trim();
      }

      const response = await fetch('/internal/upload', {
        method: 'POST',
        headers,
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
    <>
      <StepHeading index={1} label="Source">
        Give Spindrift one directory to understand.
      </StepHeading>

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

      <p className="mt-3 text-xs text-muted-foreground">
        Service and Website preselect a kind; Upload and Link repo let detection
        propose one. Discover is a separate multi-App branch.
      </p>

      {draft.source.kind === 'repo' ? (
        <div className="mt-5 flex flex-col gap-3">
          <RepoPicker
            repos={repos}
            selected={draft.source.repo}
            onSelect={(fullName, url) =>
              dispatch({ type: 'repo', fullName, url })
            }
          />
          <Field
            name="subpath"
            label="Root directory"
            value={draft.source.subpath}
            onChange={(event) =>
              dispatch({ type: 'subpath', subpath: event.target.value })
            }
            hint="Named, never searched — Spindrift does not roam the tree."
          />
        </div>
      ) : (
        <Card className="mt-5">
          <CardContent className="flex flex-col gap-3 p-4">
            <div className="flex items-center gap-3">
              <Badge tone="accent">archive</Badge>
              <div className="flex-1">
                <p className="font-mono text-sm">{draft.source.filename}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  {draft.source.digest}
                </p>
                {draft.source.location ? (
                  <p className="font-mono text-[11px] text-success">
                    staged: {draft.source.location}
                  </p>
                ) : null}
              </div>
            </div>
            <div className="mt-1 flex flex-col gap-2">
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
              {uploadError ? (
                <p className="text-xs text-destructive">{uploadError}</p>
              ) : null}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="mt-4 flex flex-col gap-3 rounded border bg-muted/40 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-foreground">
            First-Party Storage Bucket (Source & Artifact Staging)
          </span>
          <Badge tone="accent">first-party</Badge>
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          Select from configured first-party Cloud Storage buckets or enter a
          custom bucket name.
        </p>
        {bucketLoadError ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            Could not load configured buckets — showing default. Enter a bucket
            name manually if needed.
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          <label
            htmlFor="source-bucket-select"
            className="text-xs font-medium text-muted-foreground"
          >
            Bucket
          </label>
          <select
            id="source-bucket-select"
            disabled={bucketsLoading}
            value={useCustom ? 'custom' : activeBucketName}
            onChange={(e) => {
              if (e.target.value === 'custom') {
                setUseCustom(true);
                setBucketName(customBucket);
              } else {
                setUseCustom(false);
                setBucketName(e.target.value);
              }
            }}
            className="rounded border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground disabled:opacity-50"
          >
            {bucketsLoading ? (
              <option value="">Loading…</option>
            ) : (
              <>
                {(buckets ?? []).map((b) => (
                  <option key={b} value={b}>
                    {b} {b === defaultBucket ? '(default · infra repo)' : ''}
                  </option>
                ))}
                <option value="custom">Custom bucket...</option>
              </>
            )}
          </select>

          {useCustom ? (
            <input
              type="text"
              placeholder="e.g. custom-spindrift-bucket"
              value={customBucket}
              onChange={(e) => {
                setCustomBucket(e.target.value);
                setBucketName(e.target.value);
              }}
              className="rounded border bg-background px-2.5 py-1.5 font-mono text-xs text-foreground"
            />
          ) : null}
        </div>

        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            disabled={!activeBucketName.trim() || testingWif}
            onClick={handleTestWif}
            className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {testingWif ? 'Testing WIF…' : 'Test WIF Permissions'}
          </button>
        </div>
        {wifStatus ? (
          <p className="text-xs font-medium text-muted-foreground">
            {wifStatus}
          </p>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            Uses credential-less Workload Identity Federation (WIF) token
            exchange with spindrift-controller service account impersonation.
          </p>
        )}
      </div>
    </>
  );
}

const KIND_NOTE = {
  service: 'A long-running process. A worker is a service that is not exposed.',
  website: 'Rendered to files or to a server image, depending on placement.',
  job: 'Runs to completion. A schedule is a field on it, never a separate noun.',
} as const satisfies Record<ComponentKind, string>;

/**
 * Derived from the note map rather than listed again, so a fourth
 * {@link ComponentKind} is a compile error here instead of a tile that silently
 * never renders. The `satisfies Record<…>` above is what makes the derivation
 * total — the list and the exhaustiveness check are then the same fact.
 */
const KINDS = Object.keys(KIND_NOTE) as readonly ComponentKind[];

/**
 * Step 2 — Component.
 *
 * Detection's proposal arrives selected, with the sentence that produced it.
 * Kinds detection ruled out stay on screen carrying their reason, so correcting
 * the proposal is reading rather than guessing.
 */
export function StepComponent({ draft, dispatch }: StepProps) {
  return (
    <>
      <StepHeading index={2} label="App and Component">
        Accept the proposal, or correct it with a reason in front of you.
      </StepHeading>

      <div className="mb-4 grid gap-3 sm:grid-cols-2">
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

      <div className="mb-3 rounded-md border border-border bg-secondary px-3 py-2.5 text-[12.5px]">
        <span className="font-semibold">Detected {draft.detection.kind}</span>
        <span className="text-subtle"> · {draft.detection.reason}</span>
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
    </>
  );
}

/**
 * Step 3 — Place.
 *
 * Vessel and Target sit on one step because together they determine
 * eligibility and artifact shape (§18). The vessel is chosen once and is
 * immutable afterwards, which is stated here — the one moment it is still a
 * decision is the one moment saying so is useful.
 *
 * Non-candidate Targets are listed, disabled, and annotated (§3). That is what
 * makes "nowhere fits" a diagnosis instead of an empty list.
 */
export function StepPlace({
  draft,
  dispatch,
  targets,
}: StepProps & { targets: readonly TargetOptionView[] }) {
  return (
    <>
      <StepHeading index={3} label="Home and placement">
        Pick the permanent vessel, then accept the suggested Target.
      </StepHeading>

      <Card className="mb-4">
        <CardContent className="flex items-center gap-3">
          <Lock aria-hidden="true" className="size-4 text-muted-foreground" />
          <div className="min-w-0">
            <Eyebrow>Immutable vessel project</Eyebrow>
            <p className="font-semibold">{draft.vessel.name}</p>
            <p className="text-xs text-muted-foreground">
              {draft.vessel.note} · cannot be changed after the App is created.
            </p>
          </div>
          <Badge
            tone={draft.vessel.ready ? 'success' : 'destructive'}
            className="ml-auto"
          >
            {draft.vessel.ready ? 'ready' : 'not provisioned'}
          </Badge>
        </CardContent>
      </Card>

      <Eyebrow>Targets, in admin rank order</Eyebrow>
      <div className="mt-2 flex flex-col gap-2">
        {targets.map((target) => (
          <Choice
            key={target.targetId}
            selected={draft.targetId === target.targetId}
            disabled={!target.candidate}
            onClick={() =>
              dispatch({ type: 'target', targetId: target.targetId })
            }
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{target.name}</span>
              <Badge tone="idle">{target.adapter}</Badge>
              {target.candidate && target.artifactType ? (
                <Badge tone="accent">{target.artifactType}</Badge>
              ) : null}
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                rank {target.rank}
              </span>
            </div>
            {target.candidate ? (
              <span className="font-mono text-xs text-muted-foreground">
                {target.canonical}
              </span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {target.reasons.map((reason, index) => (
                  <li key={reason} className="text-xs text-destructive">
                    <span className="font-mono font-semibold">{reason}</span>
                    {target.detail[index] ? ` — ${target.detail[index]}` : ''}
                  </li>
                ))}
              </ul>
            )}
          </Choice>
        ))}
      </div>
    </>
  );
}

const EXPOSURE_NOTE = {
  internal:
    'Reachable inside the Target only, authenticated at the workload boundary.',
  private:
    'Internet reachable, behind the Target-native authenticated edge. The default.',
  public: 'Intentionally unauthenticated. Confirmed once, explicitly.',
} as const satisfies Record<Exposure, string>;

/** Derived, for the same reason {@link KINDS} is. */
const EXPOSURES = Object.keys(EXPOSURE_NOTE) as readonly Exposure[];

/**
 * Step 4 — Configure.
 *
 * Exposure first, because §9 makes `private` the default and going public is a
 * decision rather than a setting. Then configuration: plain key-value with no
 * secret / non-secret classification, one secret per variable, and values that
 * are **write-only** the moment they are stored (§10).
 *
 * The write-only property is stated on the screen, not just honoured behind it.
 * A developer who expects to come back and read a value later needs to learn
 * that here, while re-entering it is still cheap.
 */
export function StepConfigure({ draft, dispatch }: StepProps) {
  return (
    <>
      <StepHeading index={4} label="Reach and config">
        Keep the common path short; explain the expensive choices in place.
      </StepHeading>

      <Eyebrow>Who can reach it?</Eyebrow>
      <div className="mt-2 grid gap-2 sm:grid-cols-3">
        {EXPOSURES.map((exposure) => (
          <Choice
            key={exposure}
            selected={draft.exposure === exposure}
            title={exposure}
            note={EXPOSURE_NOTE[exposure]}
            onClick={() => dispatch({ type: 'exposure', exposure })}
          />
        ))}
      </div>

      <hr className="my-5 border-border" />

      <Eyebrow>Config</Eyebrow>
      <div className="mt-2 flex flex-col gap-2">
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
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Values are write-only. Spindrift stores one secret per variable and
        never reads one back — including here, which is why a key you leave
        empty cannot be filled in from this screen later. A config change
        produces a new Deploy.
      </p>
    </>
  );
}

/**
 * Step 5 — Review, with the preflight folded in.
 *
 * When a prerequisite is unmet, the button is off and the reason is on the
 * screen with what clears it — and **the draft is kept**. Task 38 is explicit
 * that an unmet prerequisite stops before any Build row exists; a flow that
 * created the App and failed afterwards would leave the developer owning a
 * half-made thing.
 */
export function StepReview({
  draft,
  targets,
  blockers,
}: {
  draft: Draft;
  targets: readonly TargetOptionView[];
  blockers: readonly Blocker[];
}) {
  const target = targets.find((option) => option.targetId === draft.targetId);
  const ready = blockers.length === 0;

  return (
    <>
      <StepHeading index={5} label="Review">
        {ready
          ? 'Ready to create the App and start Build #1.'
          : 'Spindrift stops before Build #1.'}
      </StepHeading>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact
          label="Source"
          value={
            draft.source.kind === 'repo'
              ? `${draft.source.repo} · ${draft.source.subpath}`
              : draft.source.filename
          }
        />
        <Fact
          label="Component"
          value={`${draft.componentName} · ${draft.kind}`}
        />
        <Fact
          label="Placement"
          value={`${target?.name ?? 'none'} · ${target?.artifactType ?? 'no artifact shape'}`}
        />
        <Fact label="URL" value={target?.canonical ?? 'pending'} />
        <Fact label="Vessel" value={`${draft.vessel.name} · immutable`} />
        <Fact label="Exposure" value={draft.exposure} />
      </dl>

      {blockers.length > 0 ? (
        <div className="mt-4 flex flex-col gap-2">
          {blockers.map((blocker) => (
            <div
              key={blocker.title}
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
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">
          Creating the App locks its vessel and dispatches the first Build.
        </p>
      )}
    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <dt>
        <Eyebrow>{label}</Eyebrow>
      </dt>
      <dd className="mt-0.5 font-mono text-sm">{value}</dd>
    </div>
  );
}

/**
 * The ledger: everything decided so far, visible from every step.
 *
 * It exists because the rail alone tells a developer where they are and not
 * what they have agreed to, and by Place the earlier answers are the ones that
 * determine whether a Target is a candidate at all.
 */
export function Ledger({
  draft,
  targets,
}: {
  draft: Draft;
  targets: readonly TargetOptionView[];
}) {
  const target = targets.find((option) => option.targetId === draft.targetId);

  return (
    <Card>
      <CardContent className="flex flex-col gap-2.5">
        <Eyebrow>Draft</Eyebrow>
        <LedgerRow label="App" value={draft.appName} />
        <LedgerRow label="Component" value={draft.componentName} />
        <LedgerRow label="Kind" value={draft.kind} />
        <LedgerRow label="Vessel" value={draft.vessel.name} />
        <LedgerRow label="Target" value={target?.name ?? '—'} />
        <LedgerRow label="Artifact" value={target?.artifactType ?? '—'} />
        <LedgerRow label="Exposure" value={draft.exposure} />
      </CardContent>
    </Card>
  );
}

function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 border-b border-border-soft pb-2 last:border-b-0 last:pb-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-auto font-mono text-xs">{value}</span>
    </div>
  );
}
