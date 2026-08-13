/**
 * The two storage systems this installation is connected to.
 *
 * They belong beside repositories and Targets rather than on a screen of their
 * own, because all four are the same kind of thing: a system outside Spindrift
 * that Spindrift holds an address and possibly a credential for. A bucket is
 * where a Source is staged and a registry is where an Artifact is pushed — but
 * neither *is* the Source or the Artifact, and while they shared a screen with
 * a list of staged bundles that distinction had nowhere to live. The objects
 * are the supply-chain ledgers now; what is left here is the connection.
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
 * **Each section reads its own state.** Two independent far sides answering one
 * `Promise.all` meant a slow bucket check was a slow registry list, and either
 * refusal blanked both. A connection that is down should read as one row that
 * is down.
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
import { Badge, Dot } from '../../ui/badge.tsx';
import { Button } from '../../ui/button.tsx';
import { Card, CardContent } from '../../ui/card.tsx';
import { Field } from '../../ui/field.tsx';
import { Logo } from '../../ui/logo.tsx';
import { Skeleton, SkeletonRows, SkeletonText } from '../../ui/skeleton.tsx';
import { cn } from '../../ui/utils.ts';

type Verification = OutputOf<'testBucketPermissions'>;
type RegistryProbe = OutputOf<'testRegistryReachability'>;
type RegistryRow = OutputOf<'listArtifactRegistries'>['registries'][number];
type SourceStorageView = OutputOf<'listSourceBuckets'>;
type BuildRoutesView = OutputOf<'listBuildRoutes'>;
type BuildRouteRow = BuildRoutesView['routes'][number];

/** What is known about one destination's reachability, right now. */
type Reachability<Result> =
  | { readonly state: 'unchecked' }
  | { readonly state: 'checking' }
  | { readonly state: 'reachable'; readonly result: Result }
  | { readonly state: 'unreachable'; readonly message: string };

/**
 * One section's own read of one far side.
 *
 * Reload is a token rather than a refetch call so that an act which changed the
 * manifest re-reads what the manifest now says, instead of patching a local
 * copy of it and hoping the two agree.
 */
function useConnection<Value>(
  read: () => Promise<
    { ok: true; value: Value } | { ok: false; failure: { message: string } }
  >,
  reloadToken: number,
): { state: 'loading' | 'error' | 'ready'; value?: Value; message?: string } {
  const [state, setState] = useState<{
    state: 'loading' | 'error' | 'ready';
    value?: Value;
    message?: string;
  }>({ state: 'loading' });

  useEffect(() => {
    let live = true;
    read()
      .then((result) => {
        if (!live) return;
        setState(
          result.ok
            ? { state: 'ready', value: result.value }
            : { state: 'error', message: result.failure.message },
        );
      })
      .catch((cause: unknown) => {
        if (!live) return;
        setState({
          state: 'error',
          message:
            cause instanceof Error ? cause.message : 'the read did not answer',
        });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  return state;
}

// --- Source buckets ---------------------------------------------------------

/** Where a Source is staged before any build route can fetch it (§4, §15). */
export function SourceBuckets() {
  const [reloadToken, setReloadToken] = useState(0);
  const loaded = useConnection<SourceStorageView>(
    () => command('listSourceBuckets', {}),
    reloadToken,
  );
  const onChanged = () => setReloadToken((token) => token + 1);

  if (loaded.state === 'loading') return <LoadingSection rows={3} />;
  if (loaded.state === 'error' || loaded.value === undefined) {
    return (
      <SectionShell>
        <Failure>{loaded.message ?? 'source storage did not answer'}</Failure>
      </SectionShell>
    );
  }
  return <SourceBucketList view={loaded.value} onChanged={onChanged} />;
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
            {/* A real form, so Enter in the one field does what the reader
                expects. The second verb stays a button: adding as the default
                is a different act, not the same act confirmed harder. */}
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

      {/* Both halves were unlabelled monospace, so a region name and the two
          IAM permissions the check actually exercised read as one undifferentiated
          string — and the second one is the entire evidence behind the `writable`
          badge above it, which is the fact worth naming. */}
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

// --- Build routes -------------------------------------------------------

/**
 * Every configured build route — where a staged Source becomes an Artifact
 * (§4, §16).
 *
 * Read-only, unlike the two sections either side of it: rank is the
 * manifest's declared order and per-App narrowing is the Builder picker on
 * the App workspace, so there is nothing here for a press to do.
 *
 * **The one row this screen cannot otherwise see: bosun.** Every other route
 * is dialed — core reaches its API directly, so a broken one shows up the
 * moment a Build is dispatched to it. Bosun is polled *in*, over
 * `/internal/bosun/claim`, so a route can be declared, secreted, and ranked
 * and still have nothing on the other end — indistinguishable, from the rest
 * of this screen, from one that is merely quiet. The health line is what
 * tells the two apart without waiting for a Build to time out and find out.
 */
export function Builders() {
  const loaded = useConnection<BuildRoutesView>(
    () => command('listBuildRoutes', {}),
    0,
  );

  if (loaded.state === 'loading') return <LoadingSection rows={2} />;
  if (loaded.state === 'error' || loaded.value === undefined) {
    return (
      <SectionShell>
        <Failure>{loaded.message ?? 'the build routes did not answer'}</Failure>
      </SectionShell>
    );
  }

  const routes = loaded.value.routes;
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

/** The claim-poll pulse and outbox depth — everything this process knows about the pool on the other end of one bosun route. */
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

/** Where every Artifact is pushed, and where a Target pulls it from (§16). */
export function ArtifactRegistries() {
  const [reloadToken, setReloadToken] = useState(0);
  const loaded = useConnection<OutputOf<'listArtifactRegistries'>>(
    () => command('listArtifactRegistries', {}),
    reloadToken,
  );
  const onChanged = () => setReloadToken((token) => token + 1);

  if (loaded.state === 'loading') return <LoadingSection rows={2} />;
  if (loaded.state === 'error' || loaded.value === undefined) {
    return (
      <SectionShell>
        <Failure>
          {loaded.message ?? 'the registry list did not answer'}
        </Failure>
      </SectionShell>
    );
  }
  return (
    <ArtifactRegistryList
      registries={loaded.value.registries}
      canHoldCredentials={loaded.value.canHoldCredentials}
      onChanged={onChanged}
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
          Set {new Date(registry.credentialUpdatedAt).toLocaleString()}.
          Forgetting it here does not revoke it at the registry.
        </p>
      ) : null}
    </form>
  );
}

// --- Shared chrome ----------------------------------------------------------

/** The frame a section keeps while it is loading or refusing. */
function SectionShell({ children }: { children: ReactNode }) {
  return <section className="flex flex-col gap-4 py-6">{children}</section>;
}

/**
 * A section that has not answered yet, in the shape of the section that will.
 *
 * Each section reads its own far side, which is the right call and had one
 * visible cost: three grey sentences of one line each, resolving at three
 * different times, each replaced by a two-column block several hundred pixels
 * tall. The screen jumped three times and the reader lost their place twice.
 *
 * So this is not a spinner in a box — it is `ConnectionSection`'s own grid, with
 * the provider column and the ruled card the real section will put there. It
 * deliberately does not guess the row count: the caller knows how many rows this
 * particular connection usually has, and a skeleton that promised six where two
 * arrive is a jump in the other direction.
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

/**
 * One connected system, in the ruled row every provider on this screen uses.
 *
 * The same two-column shape as the repository and Target sections: the system
 * and its one-line state on the left, everything concrete about it on the
 * right. Matching them is the point — a bucket and a cluster are the same kind
 * of thing here, and a section that looked different would read as a different
 * kind of thing.
 */
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
