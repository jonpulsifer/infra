/**
 * The Connections sections for source buckets, build routes and artifact
 * registries. Each reads its own far side, so one that is down fails alone.
 */
import {
  AlertTriangle,
  Check,
  Database,
  Hammer,
  KeyRound,
  Loader2,
  Package,
  Plus,
  Star,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { BUILD_ADAPTER } from '../../client/build-adapters.ts';
import { command, type OutputOf } from '../../client.ts';
import { useRead } from '../../poll.ts';
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';
import { Logo } from '../../ui/logo.tsx';
import { Skeleton, SkeletonRows, SkeletonText } from '../../ui/skeleton.tsx';
import { Timestamp } from '../../ui/timestamp.tsx';
import { cn } from '../../ui/utils.ts';

type Verification = OutputOf<'testBucketPermissions'>;
type RegistryProbe = OutputOf<'testRegistryReachability'>;
type RegistryRow = OutputOf<'listArtifactRegistries'>['registries'][number];
type SourceStorageView = OutputOf<'listSourceBuckets'>;
type BuildRoutesView = OutputOf<'listBuildRoutes'>;
type BuildRouteRow = BuildRoutesView['routes'][number];

type Reachability<Result> =
  | { readonly state: 'unchecked' }
  | { readonly state: 'checking' }
  | { readonly state: 'reachable'; readonly result: Result }
  | { readonly state: 'unreachable'; readonly message: string };

export function SourceBuckets() {
  const read = useRead([['listSourceBuckets', {}]], null);

  if (read.type === 'loading') return <LoadingSection rows={3} />;
  if (read.type === 'error') {
    return (
      <SectionShell>
        <Failure>{read.failure.message}</Failure>
      </SectionShell>
    );
  }
  return <SourceBucketList view={read.value[0]} onChanged={read.reload} />;
}

function SourceBucketList({
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

  // Only the default verifies on load, so N buckets do not cost N calls.
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
    <ConnectionSection
      name="Cloud Storage"
      mark={<Logo name="google-cloud" />}
      status={
        view.canVerify
          ? `${view.buckets.length} bucket${view.buckets.length === 1 ? '' : 's'}`
          : 'unverifiable'
      }
      tone={view.canVerify ? 'success' : 'warning'}
      description="Where an uploaded archive and a repository's source are staged before a builder can fetch them. The default is what a new deploy uses; the creation flow shows it and does not ask."
      action={
        view.canVerify ? (
          <Button variant="outline" onClick={() => setAdding((it) => !it)}>
            <Plus aria-hidden="true" /> Add a bucket
          </Button>
        ) : null
      }
    >
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
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void use(name.trim(), false);
              }}
            >
              <Field
                name="bucket"
                label="Bucket name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="spindrift-sources"
                hint="Checked before it is added — a bucket the controller cannot write to is a build that dies at staging."
              />
              <div className="flex flex-wrap gap-2">
                <Button type="submit" disabled={busy || name.trim() === ''}>
                  {busy ? 'Checking…' : 'Verify and add'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || name.trim() === ''}
                  onClick={() => use(name.trim(), true)}
                >
                  Add as default
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
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
    </ConnectionSection>
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
        <dl className="flex flex-wrap gap-x-4 gap-y-0.5 pl-6 text-[11px] text-subtle">
          <div className="flex gap-1.5">
            <dt>Region</dt>
            <dd className="font-mono">{check.result.location}</dd>
          </div>
          <div className="flex gap-1.5">
            <dt>Granted</dt>
            <dd className="font-mono">
              {check.result.permissions.join(' · ')}
            </dd>
          </div>
        </dl>
      ) : null}
      {check.state === 'unreachable' ? (
        <p className="pl-6 text-xs text-destructive">{check.message}</p>
      ) : null}
    </div>
  );
}

/**
 * Read-only. Bosun hosts poll in for work and are never dialled, so a bosun
 * route's health line is the only sign that a host is on the other end.
 */
export function Builders() {
  const read = useRead([['listBuildRoutes', {}]], null);

  if (read.type === 'loading') return <LoadingSection rows={2} />;
  if (read.type === 'error') {
    return (
      <SectionShell>
        <Failure>{read.failure.message}</Failure>
      </SectionShell>
    );
  }

  const routes = read.value[0].routes;
  return (
    <ConnectionSection
      name="Builders"
      mark={<Hammer aria-hidden="true" className="size-5 text-foreground" />}
      status={`${routes.length} configured`}
      tone={routes.length > 0 ? 'success' : 'idle'}
      description="Where a staged Source becomes an Artifact. Rank and per-App narrowing live in the manifest and the Builder picker on the App workspace — this is a read, not a control."
    >
      <Card className="divide-y divide-border">
        {routes.map((route) => (
          <BuildRouteRowView key={route.name} route={route} />
        ))}
      </Card>
    </ConnectionSection>
  );
}

function BuildRouteRowView({ route }: { route: BuildRouteRow }) {
  const platform = BUILD_ADAPTER[route.adapter];
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {platform ? <Logo name={platform.logo} className="size-4" /> : null}
        <span className="text-sm font-medium">
          {route.name}
          {platform ? ` · ${platform.label}` : ''}
        </span>
        <Badge tone="idle">{`SLSA L${route.level}`}</Badge>
      </div>
      {route.bosun ? <BosunPoolHealth health={route.bosun} /> : null}
    </div>
  );
}

/**
 * What this process has seen of one bosun route's pool: claim polls and outbox
 * depth.
 */
function BosunPoolHealth({
  health,
}: {
  health: NonNullable<BuildRouteRow['bosun']>;
}) {
  if (health.lastClaimPollAgo === null) {
    return (
      <p className="pl-6 text-xs text-warning">
        no bosun host has polled (this process)
      </p>
    );
  }
  const oldest =
    health.oldestPendingAgo === null
      ? ''
      : ` (oldest ${health.oldestPendingAgo})`;
  const claimed = health.claimed > 0 ? ` · ${health.claimed} claimed` : '';
  return (
    <p className="pl-6 text-[11px] text-subtle">
      last claim poll {health.lastClaimPollAgo} · {health.pending} pending
      {oldest}
      {claimed}
    </p>
  );
}

/**
 * Labels only: every registry speaks the distribution API, so an unknown one
 * just reads `Registry`.
 */
const FLAVOUR_LABEL: Record<RegistryRow['flavour'], string> = {
  artifactRegistry: 'Artifact Registry',
  dockerHub: 'Docker Hub',
  ghcr: 'GitHub Container Registry',
  other: 'Registry',
};

export function ArtifactRegistries() {
  const read = useRead([['listArtifactRegistries', {}]], null);

  if (read.type === 'loading') return <LoadingSection rows={2} />;
  if (read.type === 'error') {
    return (
      <SectionShell>
        <Failure>{read.failure.message}</Failure>
      </SectionShell>
    );
  }
  const [listed] = read.value;
  return (
    <ArtifactRegistryList
      registries={listed.registries}
      canHoldCredentials={listed.canHoldCredentials}
      onChanged={read.reload}
    />
  );
}

function ArtifactRegistryList({
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
    <ConnectionSection
      name="Artifact registries"
      mark={<Package aria-hidden="true" className="size-5 text-foreground" />}
      status={`${registries.length} connected`}
      tone={registries.length > 0 ? 'success' : 'idle'}
      description="Where every Artifact a Build produces is pushed, and where a Target pulls it from. The same digest goes to all of them; a Target that names no reachable registry pulls from the first."
      action={
        <Button variant="outline" onClick={() => setAdding((it) => !it)}>
          <Plus aria-hidden="true" /> Connect a registry
        </Button>
      }
    >
      {error ? <Failure>{error}</Failure> : null}

      {adding ? (
        <Card>
          <CardContent>
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void use(namespace.trim(), false);
              }}
            >
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
                  type="submit"
                  disabled={busy || namespace.trim() === ''}
                >
                  {busy ? 'Checking…' : 'Verify and connect'}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || namespace.trim() === ''}
                  onClick={() => use(namespace.trim(), true)}
                >
                  Connect as first
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setAdding(false)}
                >
                  Cancel
                </Button>
              </div>
            </form>
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
    </ConnectionSection>
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

      {/* GHCR accepts only classic PATs and an Actions run's own token, never
          an App token. Only the hosted route has a run token. */}
      {registry.flavour === 'ghcr' && registry.credentialUsername === null ? (
        <p className="pl-6 text-xs text-muted-foreground">
          Pushing here from any route but hosted Actions needs a stored classic
          PAT (write:packages): GitHub&apos;s registry accepts no App token.
        </p>
      ) : null}
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
 * The token is write-only: the listing carries only the username, so the field
 * starts empty even where a token is stored.
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
    <form
      className="ml-6 mt-1 flex flex-col gap-3 rounded-md border border-border bg-secondary/40 px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        void act(async () => {
          const result = await command('setRegistryCredential', {
            registry: registry.namespace,
            username: username.trim(),
            secret,
          });
          return result.ok
            ? { ok: true }
            : { ok: false, message: result.failure.message };
        });
      }}
    >
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
          type="submit"
          disabled={busy || username.trim() === '' || secret === ''}
        >
          {busy ? 'Checking…' : 'Verify and save'}
        </Button>
        {registry.credentialUsername !== null ? (
          <Button
            type="button"
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
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {registry.credentialUpdatedAt !== null ? (
        <p className="text-[11px] text-subtle">
          Set <Timestamp at={registry.credentialUpdatedAt} />. Forgetting it
          here does not revoke it at the registry.
        </p>
      ) : null}
    </form>
  );
}

function SectionShell({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-4 py-6">{children}</section>;
}

/**
 * `ConnectionSection`'s own grid, so the loaded section appears without a jump.
 * The caller passes the row count its connection usually has.
 */
function LoadingSection({ rows }: { rows: number }) {
  return (
    <section className="grid gap-5 py-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-24 rounded-full" />
        <SkeletonText lines={3} />
      </div>
      <div className="min-w-0 rounded-md border border-border">
        <SkeletonRows rows={rows} />
      </div>
    </section>
  );
}

/** The two-column shape the repository and Target sections also use. */
function ConnectionSection({
  name,
  mark,
  status,
  tone,
  description,
  action,
  children,
}: {
  readonly name: string;
  readonly mark: ReactNode;
  readonly status: string;
  readonly tone: 'success' | 'warning' | 'idle';
  readonly description: string;
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="grid gap-5 py-6 xl:grid-cols-[240px_minmax(0,1fr)] xl:gap-8">
      <div>
        <div className="flex items-center gap-2">
          {mark}
          <h3 className="font-semibold">{name}</h3>
        </div>
        <Badge className="mt-3" tone={tone}>
          <Dot /> {status}
        </Badge>
        <p className="mt-3 text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        {action ? <div className="flex justify-end">{action}</div> : null}
        {children}
      </div>
    </section>
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
  /**
   * A bucket check uses the identity that writes to it and proves `writable`.
   * A registry check with no stored credential is anonymous and proves it
   * `answers`.
   */
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
