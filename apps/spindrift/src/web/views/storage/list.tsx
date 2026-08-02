/**
 * Source storage — where an archive or a repository's source is staged (§4).
 *
 * This existed as three controls buried in step one of the creation flow: a
 * `<select>` of the manifest's buckets, a "Custom bucket…" option that let a
 * developer type an undeclared bucket and stage a build into it, and a "Test
 * WIF Permissions" button whose result was a sentence nobody kept. All three
 * were configuration wearing the costume of a deploy form.
 *
 * They are one screen now, and the creation flow shows the default as a fact.
 * The move is not only tidying: a bucket that is typed on a deploy form is a
 * bucket that is never declared, and §20 puts every value naming this
 * installation in the manifest — which `useSourceBucket` writes to, after
 * verifying that the controller can actually write there.
 *
 * The default bucket verifies itself on arrival. Every other bucket verifies
 * on request, because a screen that made N calls to Cloud Storage on load
 * would be a screen that is slow in proportion to how much storage you have,
 * and the default is the one whose health actually decides whether the next
 * deploy works.
 */
import {
  AlertTriangle,
  Check,
  Database,
  Loader2,
  Plus,
  Star,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { command, type OutputOf } from '../../client.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';
import { cn } from '../../ui/utils.ts';

type Verification = OutputOf<'testBucketPermissions'>;

/** What is known about one bucket's reachability, right now. */
type Reachability =
  | { readonly state: 'unchecked' }
  | { readonly state: 'checking' }
  | { readonly state: 'reachable'; readonly result: Verification }
  | { readonly state: 'unreachable'; readonly message: string };

export interface SourceStorageView {
  readonly buckets: readonly string[];
  readonly defaultBucket: string;
  readonly canVerify: boolean;
}

export function SourceStorage({
  view,
  onChanged,
}: {
  view: SourceStorageView;
  /** Re-read after the manifest moved: this screen does not own that state. */
  onChanged: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, Reachability>>({});
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async (bucket: string) => {
    setChecks((current) => ({ ...current, [bucket]: { state: 'checking' } }));
    try {
      const result = await command('testBucketPermissions', {
        bucketName: bucket,
      });
      setChecks((current) => ({
        ...current,
        [bucket]: result.ok
          ? { state: 'reachable', result: result.value }
          : { state: 'unreachable', message: result.failure.message },
      }));
    } catch (cause) {
      setChecks((current) => ({
        ...current,
        [bucket]: {
          state: 'unreachable',
          message:
            cause instanceof Error ? cause.message : 'the check did not answer',
        },
      }));
    }
  };

  // The default only. See the module note: N buckets should not mean N calls.
  useEffect(() => {
    if (!view.canVerify || view.defaultBucket === '') return;
    void verify(view.defaultBucket);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.defaultBucket, view.canVerify]);

  const use = async (bucketName: string, makeDefault: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command('useSourceBucket', {
        bucketName,
        makeDefault,
      });
      if (!result.ok) {
        setError(result.failure.message);
        return;
      }
      setChecks((current) => ({
        ...current,
        [bucketName]: {
          state: 'reachable',
          result: {
            bucketName,
            accessible: true,
            location: result.value.location,
            permissions: result.value.permissions,
          },
        },
      }));
      setAdding(false);
      setName('');
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'the bucket could not be used',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1040px] flex-col gap-5 px-5 py-6">
      <header className="flex flex-wrap items-end gap-4">
        <div>
          <Eyebrow>Storage</Eyebrow>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            Source storage
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">
            Where an uploaded archive and a repository's source are staged
            before a builder can fetch them. The default is what a new deploy
            uses; the creation flow shows it and does not ask.
          </p>
        </div>
        {view.canVerify ? (
          <Button
            variant="outline"
            className="ml-auto"
            onClick={() => setAdding((open) => !open)}
          >
            <Plus aria-hidden="true" /> Add a bucket
          </Button>
        ) : null}
      </header>

      {!view.canVerify ? (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5">
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-warning"
          />
          <p className="text-sm">
            Workload Identity Federation is not configured, so Spindrift has no
            identity to check a bucket with. Buckets below are what the manifest
            declares and nothing here has confirmed them.
          </p>
        </div>
      ) : null}

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {adding ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Field
              name="bucket"
              label="Bucket name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="spindrift-sources"
              hint="Checked before it is added — a bucket the controller cannot write to is a build that dies at staging."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || name.trim() === ''}
                onClick={() => use(name.trim(), false)}
              >
                {busy ? 'Checking…' : 'Verify and add'}
              </Button>
              <Button
                variant="outline"
                disabled={busy || name.trim() === ''}
                onClick={() => use(name.trim(), true)}
              >
                Add as default
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="divide-y divide-border">
        {view.buckets.map((bucket) => (
          <BucketRow
            key={bucket}
            bucket={bucket}
            isDefault={bucket === view.defaultBucket}
            check={checks[bucket] ?? { state: 'unchecked' }}
            canVerify={view.canVerify}
            busy={busy}
            onVerify={() => void verify(bucket)}
            onMakeDefault={() => use(bucket, true)}
          />
        ))}
      </Card>
    </div>
  );
}

function BucketRow({
  bucket,
  isDefault,
  check,
  canVerify,
  busy,
  onVerify,
  onMakeDefault,
}: {
  bucket: string;
  isDefault: boolean;
  check: Reachability;
  canVerify: boolean;
  busy: boolean;
  onVerify: () => void;
  onMakeDefault: () => void;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Database
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="font-mono text-sm font-medium">{bucket}</span>
        {isDefault ? (
          <Badge tone="accent">
            <Star aria-hidden="true" className="size-3" />
            default
          </Badge>
        ) : null}
        <CheckBadge check={check} />
        <div className="ml-auto flex gap-2">
          {!isDefault ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !canVerify}
              onClick={onMakeDefault}
            >
              Make default
            </Button>
          ) : null}
          {canVerify ? (
            <Button
              size="sm"
              variant="outline"
              disabled={check.state === 'checking'}
              onClick={onVerify}
            >
              {check.state === 'checking' ? 'Checking…' : 'Verify'}
            </Button>
          ) : null}
        </div>
      </div>

      {check.state === 'reachable' ? (
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[11px] text-subtle">
          <span className="font-mono">{check.result.location}</span>
          <span className="font-mono">
            {check.result.permissions.join(' · ')}
          </span>
        </div>
      ) : null}
      {check.state === 'unreachable' ? (
        <p className="pl-6 text-xs text-destructive">{check.message}</p>
      ) : null}
    </div>
  );
}

function CheckBadge({ check }: { check: Reachability }) {
  switch (check.state) {
    case 'checking':
      return (
        <Badge tone="idle">
          <Loader2 aria-hidden="true" className={cn('size-3 animate-spin')} />
          checking
        </Badge>
      );
    case 'reachable':
      return (
        <Badge tone="success">
          <Check aria-hidden="true" className="size-3" />
          writable
        </Badge>
      );
    case 'unreachable':
      return (
        <Badge tone="destructive">
          <X aria-hidden="true" className="size-3" />
          unreachable
        </Badge>
      );
    default:
      return null;
  }
}
