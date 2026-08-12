/**
 * The adapters a running installation actually has (§6, §20).
 *
 * `CommandContext.adapters` is the whole of the far side a command may reach,
 * and until now nothing assembled one outside a test — `src/web/serve.ts` threw
 * rather than fabricating a registry, because a placeholder would have let a
 * command half-run. This is what replaces that throw.
 *
 * The shape of the answers is the interesting part, and it comes from
 * `AdapterRegistry`'s own contract: **lookups return `null` rather than
 * throwing**, because an installation with no adapter for a Target's declared
 * type is a configuration fact a command must report, not an exception it
 * should propagate. All three deploy backends, all three build routes, and
 * both datastore adapters are wired below; `null` here now means "this
 * installation didn't configure one" — no OAuth store for hosted CI, no route
 * by that name, `static`'s deliberate absence from `datastoreAdapters` — and
 * every caller already handles that: a Target whose adapter is missing is a
 * non-candidate with a stated reason (§3), which is exactly right for a
 * configuration gap.
 *
 * §13's one auth mode is why there is no credential in this file: "native OIDC
 * federation, nothing stored." The cluster Spindrift runs on is reached with
 * its own **projected** service account token, read from disk per request
 * because it rotates, and a projected token is not a held credential (§13).
 */

import { createHash } from 'node:crypto';
import type { AdapterRegistry } from '../commands/types.ts';
import {
  type BuildRouteConfig,
  type StoreAdapter,
  sharedServicesOf,
  type TargetAdapter,
} from '../config/manifest.schema.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import { CredentialKeyring } from '../crypto/credential-envelope.ts';
import type { Database } from '../db/client.ts';
import type { BuildRouteProfile } from '../domain/build-route.ts';
import type {
  RepositoryAuthorization,
  RepositoryHost,
} from '../domain/repository.ts';
import {
  type RepositorySourceStager,
  stageSourceBundle,
} from '../domain/source-bundle.ts';
import { GitHubApp } from '../integrations/github/app.ts';
import type { Fetcher } from '../integrations/github/http.ts';
import { GitHubDeviceOAuth } from '../integrations/github/oauth.ts';
import { sourceDepotFor, stageArchiveBytes } from '../storage/archives.ts';
import { buildOutbox } from '../storage/build-outbox.ts';
import { withGitHubRegistryCredential } from '../storage/github-registry-credential.ts';
import { registryCredentialStore } from '../storage/registry-credentials.ts';
import { CoreSupplyChain, CosignSigner } from '../supply-chain/sign.ts';
import { SpindriftSignatureVerifier } from '../supply-chain/signature.ts';
import { SlsaVerifier } from '../supply-chain/verify.ts';
import type { BosunOutbox } from './build/bosun.ts';
import type { BuildAdapter } from './build/contract.ts';
import { findBuildRouteDescriptor } from './build/descriptors.ts';
import { GcpDiscovery } from './cloud-discovery.ts';
import type { DatastoreAdapter } from './datastore/contract.ts';
import { CloudDatastoreAdapter } from './datastore/gcp.ts';
import { KubernetesDatastoreAdapter } from './datastore/kubernetes.ts';
import { workloadIdentityToken } from './deploy/cloud/federation.ts';
import { CloudRunDeployAdapter } from './deploy/cloudrun/index.ts';
import type { DeployAdapter } from './deploy/contract.ts';
import type { TokenProvider } from './deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from './deploy/kubernetes/index.ts';
import { PagesDeployAdapter } from './deploy/pages/index.ts';
import { StaticDeployAdapter } from './deploy/static/index.ts';
import { VercelDeployAdapter } from './deploy/vercel/index.ts';
import type { SecretStore } from './store/contract.ts';
import { SecretManagerStore } from './store/gcp-secret-manager.ts';
import { OnePasswordStore } from './store/onepassword.ts';

/**
 * Where Kubernetes projects a pod's service account token.
 *
 * Read on every request rather than once at boot: a projected token has a short
 * lifetime and the kubelet rewrites the file, so a value cached at start-up
 * stops working part way through the day — the classic failure this path exists
 * to avoid.
 */
export const SERVICE_ACCOUNT_TOKEN_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/token';
/** Installer-declared path for the reconciler's audience-scoped token. */
export const IDENTITY_TOKEN_PATH_VAR = 'SPINDRIFT_IDENTITY_TOKEN_PATH';

/** Raised when something reaches for an adapter this installation cannot build. */
export class AdapterUnavailableError extends Error {
  override readonly name = 'AdapterUnavailableError';
}

/** Reads the projected token from disk, freshly, on every call. */
export function projectedServiceAccountToken(
  path: string = SERVICE_ACCOUNT_TOKEN_PATH,
): TokenProvider {
  return async () => {
    const file = Bun.file(path);
    if (!(await file.exists())) {
      throw new AdapterUnavailableError(
        `no projected service account token at ${path}: this process cannot reach a Kubernetes Target. ` +
          'A pod needs `automountServiceAccountToken` or an explicit projected token volume.',
      );
    }
    return (await file.text()).trim();
  };
}

/**
 * The Kubernetes credential projected for this process.
 *
 * The installer uses an explicit audience and mount rather than automounting a
 * default credential. Falling back keeps non-chart development environments
 * compatible with Kubernetes' conventional service-account path.
 */
export function installationServiceAccountToken(
  env: Record<string, string | undefined> = Bun.env,
): TokenProvider {
  const configured = env[IDENTITY_TOKEN_PATH_VAR]?.trim();
  return projectedServiceAccountToken(configured || SERVICE_ACCOUNT_TOKEN_PATH);
}

export interface RegistryOptions {
  readonly manifest: InstallationManifest;
  /** Required for the durable OAuth credential and Device Flow attempts. */
  readonly db?: Database;
  /** Shared with commands so token expiry and rows agree on one time source. */
  readonly clock?: import('../commands/types.ts').Clock;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly token?: TokenProvider;
  /** Injected for the same reason, for the repository host's transport. */
  readonly fetch?: Fetcher;
  /** Defaults to the process environment; a test passes its own. */
  readonly env?: Record<string, string | undefined>;
  /** Likewise for the store's own access path, which authorizes separately. */
  readonly storeToken?: () => string | Promise<string>;
  /** And for the two edge platforms, whose bearers are neither of the above. */
  readonly vercelToken?: TokenProvider;
  readonly cloudflareToken?: TokenProvider;
  /**
   * And for the cloud APIs — the runtimes a Target is deployed to and the build
   * service a cloud build is submitted to, which are one credential.
   */
  readonly cloudToken?: () => string | Promise<string>;
  /** Source depot wiring, supplied by the live source-ingestion installation. */
  readonly source?: RepositorySourceStager;
}

/**
 * Assemble the registry one installation has.
 *
 * Adapters are built once and shared: they hold no per-request state, and their
 * one credential is a provider that is called per request rather than a value
 * captured here.
 */
export function createAdapterRegistry(
  options: RegistryOptions,
): AdapterRegistry {
  const kubernetes = new KubernetesDeployAdapter({
    chart: options.manifest.charts.app,
    token:
      options.token ?? installationServiceAccountToken(options.env ?? Bun.env),
  });

  // The connector exists only where both halves of its durable boundary exist:
  // Postgres for ciphertext and an installation-Secret keyring to open it.
  // The GitHub App's public client id stays in the manifest; no App private key
  // or client secret is present in this process.
  const keyring = CredentialKeyring.fromEnvironment(options.env ?? Bun.env);
  const oauth =
    keyring !== null && options.db !== undefined
      ? new GitHubDeviceOAuth({
          db: options.db,
          clock: options.clock ?? { now: () => new Date() },
          keyring,
          clientId: options.manifest.github.clientId,
          oauthBaseUrl: options.manifest.github.oauthBaseUrl,
          apiBaseUrl: options.manifest.github.apiBaseUrl,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null;
  // Held as its concrete type because the hosted build route needs Actions
  // calls beyond `RepositoryHost`; all calls share the same refresh provider.
  const app =
    oauth === null
      ? null
      : new GitHubApp({
          baseUrl: options.manifest.github.apiBaseUrl,
          authorization: () => oauth.authorization(),
          onUnauthorized: (authorization) =>
            oauth.rejectedAuthorization(authorization),
          principalSubject: (ref) => oauth.principalSubject(ref.installationId),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  const repositoryHost: RepositoryHost | null = app;
  const repositoryAuthorization: RepositoryAuthorization | null =
    oauth === null || app === null
      ? null
      : {
          status: () => oauth.status(),
          begin: (userId) => oauth.begin(userId),
          poll: (userId, attemptId) => oauth.poll(userId, attemptId),
          repositories: () => app.availableRepositories(),
          installationFor: (fullName) => app.installationFor(fullName),
        };
  // **Not the projected service account token this cluster is reached with.**
  // That one is minted for this cluster's own API server and a cloud API
  // refuses it; the failure would be a `401` on every cloud deploy, blamed on
  // the Target. What belongs here is a federated token, which is what
  // `cloudTokenFor` mints — see `cloud/federation.ts`. The cloud build route
  // submits with it too, so it is resolved before the routes are built.
  const cloud = cloudTokenFor(options);

  const store = createSecretStore(
    options.manifest,
    options.storeToken ?? storeTokenFor(options.manifest, cloud, options.env),
    options.fetch,
  );
  const supplyChain = new CoreSupplyChain(
    new SlsaVerifier(),
    new CosignSigner({ key: options.manifest.supplyChain.signer }),
    // §16: admission re-verifies the recorded signature against the recorded
    // digest, pinned to Spindrift's own signer. The signer and verifier are
    // the same pinned binary, so this is the process boundary around the
    // verify half, not a second trust root.
    new SpindriftSignatureVerifier({
      signerKey: options.manifest.supplyChain.signer,
    }),
  );

  // A fourth consumer of that one provider rather than a fourth credential.
  const discovery = new GcpDiscovery({
    token: cloud,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  // The bosun route's outbox: built once, over the same `db` the registry
  // credential store is, and `null` under the identical condition —
  // "no database, no durable state this route can claim against".
  const outbox =
    options.db === undefined
      ? null
      : buildOutbox(options.db, () =>
          (options.clock ?? { now: () => new Date() }).now(),
        );

  // §16's ordered list: the manifest's order *is* the admin rank, so the map is
  // built from it in order and `buildRouteProfiles` reads it back the same way.
  const buildRoutes = new Map<string, BuildAdapter>();
  for (const route of options.manifest.build.routes) {
    const built = createBuildRoute(route, options, app, cloud, outbox);
    if (built !== null) buildRoutes.set(route.name, built);
  }

  // The two cloud adapters hold no per-Target state either: each Target's
  // connection carries its own endpoint and project, so one instance drives
  // every connected project the same way the cluster adapter drives every
  // cluster.
  const deployAdapters: Partial<Record<TargetAdapter, DeployAdapter>> = {
    kubernetes,
    cloudrun: new CloudRunDeployAdapter({
      token: cloud,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    static: new StaticDeployAdapter({
      token: cloud,
      // The one adapter that also reads the source depot: a supplied upload
      // was never built, so its bytes are a `gs://` object rather than a
      // registry reference, and fetching one takes a signature rather than a
      // bearer. The federation itself, because signing happens *before*
      // impersonation — `storage/signed-url.ts` says why.
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    // The one adapter with two identities: the platform is driven with the
    // installation's own bearer, and the artifact is read out of the artifacts
    // registry with the federated token every other adapter already holds. The
    // federation is neither of those — it is the signature a supplied upload's
    // `gs://` object takes, the same one the static backend above needs.
    vercel: new VercelDeployAdapter({
      token: options.vercelToken ?? vercelToken(options.env ?? Bun.env),
      artifactToken: cloud,
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    // The simpler of the two edge backends: it fetches its own artifact with the
    // same bearer it deploys with, because a staged bundle is a plain GET. The
    // federation is not a second bearer — it is the signature the one address
    // that is *not* a plain GET takes, a supplied upload's `gs://` object.
    'cloudflare-pages': new PagesDeployAdapter({
      token: options.cloudflareToken ?? cloudflareToken(options.env ?? Bun.env),
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  };

  // §11's lifecycle, keyed the way the deploy adapters are. Both static
  // hosting adapters are absent rather than mapped to a refusing one: neither
  // has a runtime to dial a datastore from, so a Datastore placed there is not
  // an unfinished path but a placement that never made sense — and `null`
  // already says exactly that.
  const datastoreAdapters: Partial<Record<TargetAdapter, DatastoreAdapter>> = {
    kubernetes: new KubernetesDatastoreAdapter({
      token:
        options.token ??
        installationServiceAccountToken(options.env ?? Bun.env),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    cloudrun: new CloudDatastoreAdapter(),
  };

  return {
    deploy(adapter: TargetAdapter): DeployAdapter | null {
      return deployAdapters[adapter] ?? null;
    },

    datastore(adapter: TargetAdapter): DatastoreAdapter | null {
      return datastoreAdapters[adapter] ?? null;
    },

    /**
     * The build route the installation configured under that name (§4).
     *
     * §4 makes the set of routes an installation's configuration rather than a
     * closed vocabulary, so an unknown name is answered with `null` and
     * `dispatchBuild` prints "this installation has no build route named X".
     * The same `null` covers a route this installation configured but cannot
     * construct — a hosted-CI route with no OAuth store — because the two are one
     * fact to whoever is trying to build: the route is not available here.
     */
    build(route: string): BuildAdapter | null {
      return buildRoutes.get(route) ?? null;
    },

    /**
     * §10's store of record, built from the access path the manifest names.
     *
     * One today: the manifest configures a single store, so every other adapter
     * answers `null` — and a Target that reaches only those is a Target this
     * installation cannot deliver config to, which is a configuration fact a
     * command reports rather than an exception it should propagate.
     *
     * Built once, like the deploy adapters and for the same reason: it holds no
     * per-request state, and its credential is a provider called per request
     * rather than a value captured here.
     */
    store(adapter: StoreAdapter): SecretStore | null {
      return adapter === options.manifest.secretStore.adapter ? store : null;
    },

    /**
     * §15's repository host, or `null` when durable OAuth is not configured.
     *
     * `null` rather than a throw, following the same rule the other lookups
     * do: an installation with no repository integration is a configuration
     * fact, and `connectRepository` reports it as a refusal an operator can
     * act on.
     */
    repository(): RepositoryHost | null {
      return repositoryHost;
    },

    /**
     * §16's registries answer their own distribution API, with no credential
     * and no adapter of their own. `options.fetch` is what a test substitutes,
     * exactly as every other far side here takes it.
     */
    registryTransport() {
      return options.fetch ?? fetch;
    },

    /**
     * Both halves or nothing, the same condition the OAuth connector is built
     * under: Postgres for the ciphertext and an installation-Secret keyring to
     * open it. An installation missing either has nowhere to keep a registry
     * token durably, and the commands say so rather than keeping one in clear.
     */
    registryCredentials() {
      const now = () => (options.clock ?? { now: () => new Date() }).now();
      const stored =
        keyring === null || options.db === undefined
          ? null
          : registryCredentialStore(options.db, keyring, now);
      // GHCR is minted from the credential this installation already refreshes
      // rather than pasted in and owned forever — see
      // `storage/github-registry-credential.ts`. A stored row for the same host
      // still wins, and an installation with no connector gets `stored` back
      // unchanged.
      return withGitHubRegistryCredential(stored, oauth, now);
    },

    source() {
      if (options.source !== undefined) return options.source;
      if (app === null) return null;
      // §15 stages one immutable bundle "for either builder", so a repository
      // commit lands in the same durable depot an upload does. It is the same
      // fix and the same reason: a bundle on this pod's disk is unfetchable by
      // a hosted runner whatever kind of source produced it.
      const depot = sourceDepotFor(options.manifest);
      const defaultSourceStager: RepositorySourceStager = {
        async stageRepository(input) {
          const staged = await stageSourceBundle(
            {
              kind: 'git',
              repository: input.repository,
              commit: input.commit,
              credential: input.ref,
            },
            {
              fetcher: app,
              depot: {
                async putImmutable(item) {
                  const archived = await stageArchiveBytes(
                    // A gzipped tar, because that is what the repository host's
                    // tarball endpoint answers with and what the reusable
                    // workflow's `tar -xz` expects.
                    `bundle-${item.digest.replace('sha256:', '')}.tgz`,
                    item.bytes,
                    depot,
                  );
                  return { location: archived.location };
                },
              },
              signer: {
                async sign(payload) {
                  const hash = createHash('sha256')
                    .update(payload)
                    .digest('hex');
                  return {
                    keyId: options.manifest.supplyChain.signer,
                    algorithm: 'sha256',
                    value: hash,
                  };
                },
              },
              receipts: {
                async putImmutable(receipt) {
                  const bytes = new TextEncoder().encode(
                    JSON.stringify(receipt),
                  );
                  const archived = await stageArchiveBytes(
                    `receipt-${receipt.statement.subject.digest.replace('sha256:', '')}.json`,
                    bytes,
                    depot,
                  );
                  return { location: archived.location };
                },
              },
            },
            input.stagedAt,
          );
          return staged.bundle;
        },
      };
      return defaultSourceStager;
    },

    repositoryAuthorization(): RepositoryAuthorization | null {
      return repositoryAuthorization;
    },

    /**
     * The reads that answer what an operator would otherwise type (§20).
     *
     * Built on the same `cloud` provider resolved above, not on a second one:
     * that is what makes discovery share `federation.ts`'s cache — one token
     * exchange an hour for the whole process — instead of re-running the STS
     * and impersonation round trip on every question asked.
     *
     * Never `null` here, even where this installation configured no federation.
     * `cloudTokenFor` answers that case with a provider that refuses, and
     * `CloudHttp` turns a refusing provider into a transport failure carrying
     * its own sentence — so the screen reads "could not be reached, because…"
     * rather than a client that is silently absent. `null` remains in the
     * signature for the registries that do not build one at all.
     */
    discovery(): GcpDiscovery {
      return discovery;
    },

    supplyChain() {
      return supplyChain;
    },
  };
}

/**
 * The build routes this installation has, in rank order, as selection sees them.
 *
 * Derived from the manifest rather than from the registry map, so a route the
 * installation configured but cannot construct still appears — placement should
 * be able to say "the hosted route is configured and this process has no OAuth
 * store" rather than silently pretending the route was never named.
 */
export function buildRouteProfiles(
  manifest: InstallationManifest,
): BuildRouteProfile[] {
  return manifest.build.routes.map((route) => {
    const descriptor = findBuildRouteDescriptor(route.adapter);
    return {
      name: route.name,
      level: descriptor?.buildLevel ?? 1,
    };
  });
}

/**
 * One configured route, or `null` where this process cannot construct it.
 */
function createBuildRoute(
  route: BuildRouteConfig,
  options: RegistryOptions,
  app: GitHubApp | null,
  cloud: TokenProvider,
  outbox: BosunOutbox | null,
): BuildAdapter | null {
  const descriptor = findBuildRouteDescriptor(route.adapter);
  if (!descriptor) return null;
  const token =
    options.token ?? installationServiceAccountToken(options.env ?? Bun.env);
  return descriptor.create(route, {
    manifest: options.manifest,
    app,
    cloud,
    token,
    outbox,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.env ? { env: options.env } : {}),
  });
}

/**
 * How this installation reaches a cloud API — a Target's control plane, and the
 * build service the cloud build route submits to.
 *
 * **No credential, in either arm.** §13 settles one auth mode — "native OIDC
 * federation, nothing stored" — and `cloud/federation.ts` is the whole of it:
 * a projected token, exchanged, optionally impersonating. An installation that
 * configured no federation gets a provider that refuses rather than one that is
 * absent, because §13's "connect always succeeds" means a cloud Target still
 * exists and still has to be able to say why it is unreachable.
 *
 * **No `SPINDRIFT_BUILD_TOKEN`, and that is the point.** The cloud build route
 * once read a bearer token out of the environment under that name, and no
 * installation ever set it: the chart renders no such Secret key, so a route
 * configured against a real build service would have refused its first build
 * with a sentence about a variable nothing writes. The build service is a cloud
 * API in the shared artifacts project like any other, the workload identity
 * this process already carries is granted on it, and a second stored credential
 * beside it is exactly the credential §13 says does not exist.
 */
function cloudTokenFor(options: RegistryOptions): TokenProvider {
  if (options.cloudToken !== undefined) return options.cloudToken;

  const federation = options.manifest.cloud.federation;
  if (federation === null) {
    return () => {
      throw new AdapterUnavailableError(
        'this installation configured no cloud federation, so it cannot reach a cloud Target',
      );
    };
  }
  return workloadIdentityToken({
    ...federation,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/**
 * The bearer token core writes to a 1Password Connect store with.
 *
 * Read per call, never captured: the installation Secret is the only place it
 * lives, and a value read once at boot is a value that stops working the moment
 * the Secret is rotated. The name is the software's, identical in every
 * installation — it names no installation, so it is not a §20 literal.
 */
export const STORE_TOKEN_VARIABLE = 'SPINDRIFT_STORE_TOKEN';

export function storeToken(env: Record<string, string | undefined> = Bun.env) {
  return (): string => {
    const token = env[STORE_TOKEN_VARIABLE]?.trim();
    if (!token) {
      throw new AdapterUnavailableError(
        `${STORE_TOKEN_VARIABLE} is not set: this installation cannot write to its secret store`,
      );
    }
    return token;
  };
}

/**
 * The bearer the edge platform is driven with.
 *
 * Read per call and never captured, exactly like {@link storeToken} and for the
 * identical reason: the installation Secret is the only place it lives, and a
 * value read once at boot stops working the moment the Secret is rotated. It is
 * the same kind of credential as the Connect token — a long-lived bearer an
 * operator issues — rather than the federated one every cloud Target uses,
 * because the platform federates outward only and offers nothing to exchange a
 * projected token for.
 *
 * A Target on an installation that set none is not absent: the provider refuses,
 * `CloudHttp` turns that into a transport failure carrying this sentence, and
 * the Target connects with its whole checklist unmet and the reason stated —
 * §13's "connect always succeeds" rather than an adapter that is quietly
 * missing. Exactly what `cloudTokenFor` does for an installation with no
 * federation.
 */
export const VERCEL_TOKEN_VARIABLE = 'SPINDRIFT_VERCEL_TOKEN';

export function vercelToken(
  env: Record<string, string | undefined> = Bun.env,
): TokenProvider {
  return (): string => {
    const token = env[VERCEL_TOKEN_VARIABLE]?.trim();
    if (!token) {
      throw new AdapterUnavailableError(
        `${VERCEL_TOKEN_VARIABLE} is not set: this installation cannot reach a Vercel Target`,
      );
    }
    return token;
  };
}

/**
 * The bearer a Cloudflare account is driven with.
 *
 * The same posture as {@link vercelToken}, one vendor over and for the same
 * reason — that platform has no inbound OIDC either — so the two are deliberately
 * spelled the same way rather than each inventing a shape. Scope it to edit that
 * account's hosting product and nothing else: core reaches no zone with it, and
 * `test/extraction/no-dns-credential.test.ts` is what keeps that true.
 *
 * One consequence is stated rather than hidden: a value read from the
 * environment cannot vary by vessel, so an installation reaches one account.
 * **ponytail:** give it a per-vessel encrypted row
 * (`crypto/credential-envelope.ts`, as `storage/registry-credentials.ts` does)
 * when a second account is a real requirement rather than a hypothetical one.
 */
export const CLOUDFLARE_TOKEN_VARIABLE = 'SPINDRIFT_CLOUDFLARE_TOKEN';

export function cloudflareToken(
  env: Record<string, string | undefined> = Bun.env,
): TokenProvider {
  return (): string => {
    const token = env[CLOUDFLARE_TOKEN_VARIABLE]?.trim();
    if (!token) {
      throw new AdapterUnavailableError(
        `${CLOUDFLARE_TOKEN_VARIABLE} is not set: this installation cannot reach a Cloudflare Target`,
      );
    }
    return token;
  };
}

/**
 * The access path core writes to the store of record over, per adapter (§10).
 *
 * §13's "native OIDC federation, nothing stored" is not a posture the two stores
 * share, because the credential each takes is not the same kind of thing. A
 * Connect token is a long-lived bearer an operator issues, so it lives in the
 * installation Secret. A Google access token expires in an hour and is minted
 * from the projected token this pod already carries, so a copy in a Secret would
 * be a credential that is stale before the second write — the federation that
 * every cloud Target already goes through is the only usable path to it.
 *
 * So the store's credential follows the store, and the same provider serves the
 * cloud Targets, the build routes, discovery, and now the cloud store. Nothing
 * new is stored, and an installation on Secret Manager needs no
 * `SPINDRIFT_STORE_TOKEN` at all.
 */
export function storeTokenFor(
  manifest: InstallationManifest,
  cloud: TokenProvider,
  env: Record<string, string | undefined> = Bun.env,
): () => string | Promise<string> {
  const adapter = manifest.secretStore.adapter satisfies StoreAdapter;
  switch (adapter) {
    case 'gcp-secret-manager':
      return cloud;
    case 'onepassword':
      return storeToken(env);
  }
}

/** The store this installation's manifest selects, over the path it names. */
export function createSecretStore(
  manifest: InstallationManifest,
  token: () => string | Promise<string> = storeToken(),
  fetch?: Fetcher,
): SecretStore {
  const endpoint = {
    baseUrl: manifest.secretStore.endpoint,
    token,
    ...(fetch ? { fetch } : {}),
  };
  // The container is the home vessel's, because that is the boundary the store
  // of record lives in — one place, whatever reaches it.
  const { secretStoreContainer } = sharedServicesOf(manifest);
  const adapter = manifest.secretStore.adapter satisfies StoreAdapter;
  switch (adapter) {
    case 'onepassword':
      return new OnePasswordStore({ ...endpoint, vault: secretStoreContainer });
    case 'gcp-secret-manager':
      return new SecretManagerStore({
        ...endpoint,
        project: secretStoreContainer,
      });
  }
}
