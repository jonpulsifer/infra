/**
 * Storage — everything this installation keeps, and which of it deploys.
 *
 * Three sections, and the order is the argument. **Source buckets** hold the
 * bundle a builder is handed. **Bundles** are those inputs themselves, one row
 * per staged digest. **Artifact registries** hold what came back out. Reading
 * down the page is reading the supply chain in the direction it runs, and the
 * distinction the sections exist to keep visible is that a source is not a
 * built artifact: nothing on this screen deploys except §4's supplied artifact,
 * an archive of finished output recorded with no builder, which is the one row
 * the bundle list marks.
 *
 * The bucket section began as three controls buried in step one of the creation
 * flow: a `<select>` of the manifest's buckets, a "Custom bucket…" option that
 * let a developer type an undeclared bucket and stage a build into it, and a
 * "Test WIF Permissions" button whose result was a sentence nobody kept. All
 * three were configuration wearing the costume of a deploy form. The creation
 * flow now shows the default as a fact, and §20 puts every value naming this
 * installation in the manifest — which `useSourceBucket` writes to, after
 * verifying that the controller can actually write there.
 *
 * **Verification is per row and on request**, in both sections that have any.
 * A screen that checked N destinations on load would be a screen slow in
 * proportion to how much storage an installation has. The default bucket is the
 * exception and verifies itself on arrival, because it is the one whose health
 * decides whether the next deploy works.
 *
 * **The two checks do not prove the same thing, and the words differ so that is
 * visible.** A bucket is checked with the federated identity that would write
 * to it, so `writable` is the claim. A registry with no held credential is
 * checked anonymously, because §13 leaves the push credential with the build
 * route that makes it — so the claim is only that it `answers`, and a registry
 * that asks who is calling is reachable rather than broken. Where a credential
 * *is* held, Verify completes the registry's own challenge with it, and then
 * the claim is the strong one.
 *
 * **A token is write-only from this screen.** The listing carries the username
 * and never the secret, so the field is empty even where one is stored: a
 * masked placeholder would suggest the value can be read back, and there is no
 * verb above the credential store that could.
 */
import {
  AlertTriangle,
  Archive,
  Check,
  Database,
  KeyRound,
  Loader2,
  Package,
  Plus,
  Star,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { command, type OutputOf } from '../../client.ts';
import { Badge } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent, Eyebrow } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';
import { cn } from '../../ui/utils.ts';

type Verification = OutputOf<'testBucketPermissions'>;
type RegistryProbe = OutputOf<'testRegistryReachability'>;
type RegistryRow = OutputOf<'listArtifactRegistries'>['registries'][number];
type BundleRow = OutputOf<'listStagedBundles'>['bundles'][number];

/** What is known about one destination's reachability, right now. */
type Reachability<Result> =
  | { readonly state: 'unchecked' }
  | { readonly state: 'checking' }
  | { readonly state: 'reachable'; readonly result: Result }
  | { readonly state: 'unreachable'; readonly message: string };

export interface SourceStorageView {
  readonly buckets: readonly string[];
  readonly defaultBucket: string;
  readonly canVerify: boolean;
}

export interface StorageView {
  readonly source: SourceStorageView;
  readonly registries: readonly RegistryRow[];
  readonly bundles: readonly BundleRow[];
  /** Whether this installation has a keyring to seal a registry token with. */
  readonly canHoldCredentials: boolean;
  /** The cap the bundle listing answered under, so a full page reads as one. */
  readonly bundleLimit: number;
}

export function Storage({
  view,
  onChanged,
  embedded = false,
}: {
  view: StorageView;
  /** Re-read after the manifest moved: this screen does not own that state. */
  onChanged: () => void;
  embedded?: boolean;
}) {
  const Heading = embedded ? 'h2' : 'h1';
  return (
    <div
      className={cn(
        'flex w-full flex-col gap-8',
        !embedded && 'mx-auto max-w-[1040px] px-5 py-6',
      )}
    >
      <header>
        <Eyebrow>Storage</Eyebrow>
        <Heading className="mt-1 text-2xl font-semibold tracking-tight">
          Sources and artifacts
        </Heading>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Where source is staged before a builder fetches it, what has been
          staged, and where the artifacts a build produced are pushed. A source
          is not a built artifact — only an uploaded archive of finished output
          deploys without a build.
        </p>
      </header>

      <SourceBuckets view={view.source} onChanged={onChanged} />
      <StagedBundles bundles={view.bundles} limit={view.bundleLimit} />
      <ArtifactRegistries
        registries={view.registries}
        canHoldCredentials={view.canHoldCredentials}
        onChanged={onChanged}
      />
    </div>
  );
}

// --- Source buckets ---------------------------------------------------------

function SourceBuckets({
  view,
  onChanged,
}: {
  view: SourceStorageView;
  onChanged: () => void;
}) {
  const [checks, setChecks] = useState<
    Record<string, Reachability<Verification>>
  >({});
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
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Source storage"
        blurb="Where an uploaded archive and a repository's source are staged before a builder can fetch them. The default is what a new deploy uses; the creation flow shows it and does not ask."
        action={
          view.canVerify ? (
            <Button variant="outline" onClick={() => setAdding((it) => !it)}>
              <Plus aria-hidden="true" /> Add a bucket
            </Button>
          ) : null
        }
      />

      {!view.canVerify ? (
        <Notice>
          Workload Identity Federation is not configured, so Spindrift has no
          identity to check a bucket with. Buckets below are what the manifest
          declares and nothing here has confirmed them.
        </Notice>
      ) : null}

      {error ? <Failure>{error}</Failure> : null}

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
    </section>
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
  check: Reachability<Verification>;
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
        <CheckBadge check={check} reachedLabel="writable" />
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

// --- Artifact registries ----------------------------------------------------

/**
 * What each registry product is called, where it is called something.
 *
 * A label and nothing more — the distribution API is the contract, so a registry
 * this list does not recognise behaves identically and simply says `Registry`.
 */
const FLAVOUR_LABEL: Record<RegistryRow['flavour'], string> = {
  artifactRegistry: 'Artifact Registry',
  dockerHub: 'Docker Hub',
  ghcr: 'GitHub Container Registry',
  other: 'Registry',
};

function ArtifactRegistries({
  registries,
  canHoldCredentials,
  onChanged,
}: {
  registries: readonly RegistryRow[];
  canHoldCredentials: boolean;
  onChanged: () => void;
}) {
  const [checks, setChecks] = useState<
    Record<string, Reachability<RegistryProbe>>
  >({});
  const [adding, setAdding] = useState(false);
  const [namespace, setNamespace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verify = async (target: string) => {
    setChecks((current) => ({ ...current, [target]: { state: 'checking' } }));
    try {
      const result = await command('testRegistryReachability', {
        namespace: target,
      });
      setChecks((current) => ({
        ...current,
        [target]: !result.ok
          ? { state: 'unreachable', message: result.failure.message }
          : result.value.answers
            ? { state: 'reachable', result: result.value }
            : { state: 'unreachable', message: result.value.detail },
      }));
    } catch (cause) {
      setChecks((current) => ({
        ...current,
        [target]: {
          state: 'unreachable',
          message:
            cause instanceof Error ? cause.message : 'the check did not answer',
        },
      }));
    }
  };

  const use = async (target: string, makeFirst: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await command('useArtifactRegistry', {
        namespace: target,
        makeFirst,
      });
      if (!result.ok) {
        setError(result.failure.message);
        return;
      }
      setChecks((current) => ({
        ...current,
        [target]: { state: 'reachable', result: result.value.probe },
      }));
      setAdding(false);
      setNamespace('');
      onChanged();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'the registry could not be used',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Artifact registries"
        blurb="Where every artifact a build produces is pushed, and where a Target pulls it from. The same digest goes to all of them; a Target that names no reachable registry pulls from the first."
        action={
          <Button variant="outline" onClick={() => setAdding((it) => !it)}>
            <Plus aria-hidden="true" /> Connect a registry
          </Button>
        }
      />

      {error ? <Failure>{error}</Failure> : null}

      {adding ? (
        <Card>
          <CardContent className="flex flex-col gap-3">
            <Field
              name="registry"
              label="Registry namespace"
              value={namespace}
              onChange={(event) => setNamespace(event.target.value)}
              placeholder="ghcr.io/an-owner"
              hint="A host and a namespace — the repository path is appended per Component. Checked before it is declared; the check proves the registry answers, never that a push will be authorized."
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy || namespace.trim() === ''}
                onClick={() => use(namespace.trim(), false)}
              >
                {busy ? 'Checking…' : 'Verify and connect'}
              </Button>
              <Button
                variant="outline"
                disabled={busy || namespace.trim() === ''}
                onClick={() => use(namespace.trim(), true)}
              >
                Connect as first
              </Button>
              <Button variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card className="divide-y divide-border">
        {registries.map((registry) => (
          <RegistryRowView
            key={registry.namespace}
            registry={registry}
            check={checks[registry.namespace] ?? { state: 'unchecked' }}
            busy={busy}
            canHoldCredentials={canHoldCredentials}
            onVerify={() => void verify(registry.namespace)}
            onMakeFirst={() => use(registry.namespace, true)}
            onCredentialChanged={onChanged}
            onFailure={setError}
          />
        ))}
      </Card>
    </section>
  );
}

function RegistryRowView({
  registry,
  check,
  busy,
  canHoldCredentials,
  onVerify,
  onMakeFirst,
  onCredentialChanged,
  onFailure,
}: {
  registry: RegistryRow;
  check: Reachability<RegistryProbe>;
  busy: boolean;
  canHoldCredentials: boolean;
  onVerify: () => void;
  onMakeFirst: () => void;
  onCredentialChanged: () => void;
  onFailure: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Package
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="font-mono text-sm font-medium">
          {registry.namespace}
        </span>
        <Badge tone="idle">{FLAVOUR_LABEL[registry.flavour]}</Badge>
        {registry.first ? (
          <Badge tone="accent">
            <Star aria-hidden="true" className="size-3" />
            first
          </Badge>
        ) : null}
        <CheckBadge check={check} reachedLabel="answers" />
        {registry.credentialUsername !== null ? (
          <Badge tone="success">
            <KeyRound aria-hidden="true" className="size-3" />
            {registry.credentialUsername}
          </Badge>
        ) : null}
        <div className="ml-auto flex gap-2">
          {canHoldCredentials ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setEditing((open) => !open)}
            >
              {registry.credentialUsername === null
                ? 'Add a credential'
                : 'Replace'}
            </Button>
          ) : null}
          {!registry.first ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={onMakeFirst}
            >
              Make first
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={check.state === 'checking'}
            onClick={onVerify}
          >
            {check.state === 'checking' ? 'Checking…' : 'Verify'}
          </Button>
        </div>
      </div>

      {check.state === 'reachable' ? (
        <p className="pl-6 text-[11px] text-subtle">{check.result.detail}</p>
      ) : null}
      {check.state === 'unreachable' ? (
        <p className="pl-6 text-xs text-destructive">{check.message}</p>
      ) : null}

      {editing ? (
        <RegistryCredentialForm
          registry={registry}
          onDone={() => {
            setEditing(false);
            onCredentialChanged();
          }}
          onCancel={() => setEditing(false)}
          onFailure={onFailure}
        />
      ) : null}
    </div>
  );
}

/**
 * Taking a registry token, and the one honest thing to say about it.
 *
 * The token is write-only from here: `listArtifactRegistries` answers with the
 * username and never the secret, so a stored credential can be *replaced* and
 * never read back. The field is therefore always empty when this opens, even
 * where one is already held — showing a masked placeholder would suggest the
 * value is retrievable, and it is not.
 *
 * The save proves the credential against the registry's own challenge before
 * storing it, which is what makes a typo a sentence here rather than an
 * `unauthorized` twenty minutes into a build.
 */
function RegistryCredentialForm({
  registry,
  onDone,
  onCancel,
  onFailure,
}: {
  registry: RegistryRow;
  onDone: () => void;
  onCancel: () => void;
  onFailure: (message: string) => void;
}) {
  const [username, setUsername] = useState(registry.credentialUsername ?? '');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (run: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusy(true);
    try {
      const result = await run();
      if (!result.ok) {
        onFailure(result.message ?? 'the registry refused the credential');
        return;
      }
      setSecret('');
      onDone();
    } catch (cause) {
      onFailure(
        cause instanceof Error ? cause.message : 'the credential was not saved',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ml-6 mt-1 flex flex-col gap-3 rounded-md border border-border bg-secondary/40 px-3 py-3">
      <Field
        name={`registry-username-${registry.host}`}
        label="Username"
        value={username}
        onChange={(event) => setUsername(event.target.value)}
        placeholder="an-owner"
        hint={`Stored in clear — it is not a secret, and it is the half that makes a wrong account visible. This credential authenticates every namespace on ${registry.host}.`}
      />
      <Field
        name={`registry-secret-${registry.host}`}
        label="Token"
        type="password"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        autoComplete="off"
        hint="Proved against the registry before it is kept, then encrypted with the installation keyring. It is never shown again — replacing it is the only way to change it."
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || username.trim() === '' || secret === ''}
          onClick={() =>
            void act(async () => {
              const result = await command('setRegistryCredential', {
                registry: registry.namespace,
                username: username.trim(),
                secret,
              });
              return result.ok
                ? { ok: true }
                : { ok: false, message: result.failure.message };
            })
          }
        >
          {busy ? 'Checking…' : 'Verify and save'}
        </Button>
        {registry.credentialUsername !== null ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                const result = await command('forgetRegistryCredential', {
                  registry: registry.namespace,
                });
                return result.ok
                  ? { ok: true }
                  : { ok: false, message: result.failure.message };
              })
            }
          >
            Forget it
          </Button>
        ) : null}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {registry.credentialUpdatedAt !== null ? (
        <p className="text-[11px] text-subtle">
          Set {new Date(registry.credentialUpdatedAt).toLocaleString()}.
          Forgetting it here does not revoke it at the registry.
        </p>
      ) : null}
    </div>
  );
}

// --- Bundles ----------------------------------------------------------------

function StagedBundles({
  bundles,
  limit,
}: {
  bundles: readonly BundleRow[];
  limit: number;
}) {
  return (
    <section className="flex flex-col gap-4">
      <SectionHeader
        title="Bundles"
        blurb="Every source bundle that has been staged, newest first. A bundle is what a builder is handed; the one that deploys as-is is an uploaded archive of finished output, which no builder ever ran over."
      />

      {bundles.length === 0 ? (
        <Card>
          <CardContent className="text-sm text-muted-foreground">
            Nothing has been staged yet. Uploading an archive or connecting a
            repository is what puts the first bundle here.
          </CardContent>
        </Card>
      ) : (
        <Card className="divide-y divide-border">
          {bundles.map((bundle) => (
            <BundleRowView
              key={`${bundle.buildId}:${bundle.digest}`}
              bundle={bundle}
            />
          ))}
        </Card>
      )}

      {bundles.length === limit ? (
        <p className="text-[11px] text-subtle">
          Showing the newest {limit}. Older bundles are reachable from the App
          they belong to.
        </p>
      ) : null}
    </section>
  );
}

function BundleRowView({ bundle }: { bundle: BundleRow }) {
  return (
    <div className="flex flex-col gap-1.5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Archive
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="font-mono text-sm font-medium">
          {shortDigest(bundle.digest)}
        </span>
        <span className="text-sm text-muted-foreground">
          {bundle.app} / {bundle.component}
        </span>
        <Badge tone="idle">{bundle.artifactType}</Badge>
        <Badge tone={bundle.retention === 'durable' ? 'success' : 'idle'}>
          {bundle.retention}
        </Badge>
        {bundle.deployable ? <Badge tone="accent">deployable</Badge> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[11px] text-subtle">
        <span className="font-mono">
          {bundle.location ?? 'no location recorded'}
        </span>
        {!bundle.fetchable ? (
          <span className="text-warning">no builder can fetch this</span>
        ) : null}
        <span>{bundle.runner ?? 'no builder ran'}</span>
        <span>{bundle.status}</span>
      </div>
    </div>
  );
}

/** `sha256:abc…` — enough to recognise, short enough to sit in a row. */
function shortDigest(digest: string): string {
  const [algorithm, hex] = digest.split(':');
  if (hex === undefined) return digest;
  return `${algorithm}:${hex.slice(0, 12)}`;
}

// --- Shared chrome ----------------------------------------------------------

function SectionHeader({
  title,
  blurb,
  action,
}: {
  title: string;
  blurb: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end gap-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          {blurb}
        </p>
      </div>
      {action ? <div className="ml-auto">{action}</div> : null}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5">
      <AlertTriangle
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-warning"
      />
      <p className="text-sm">{children}</p>
    </div>
  );
}

function Failure({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-sm text-destructive">
      {children}
    </div>
  );
}

function CheckBadge<Result>({
  check,
  reachedLabel,
}: {
  check: Reachability<Result>;
  /** What being reachable *means* here — the two checks do not prove the same. */
  reachedLabel: string;
}) {
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
          {reachedLabel}
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
