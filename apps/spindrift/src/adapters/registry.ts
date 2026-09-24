/**
 * The adapters a running installation has. A lookup answers `null`, never a
 * throw, when the installation configured none, so a command can report the gap.
 */

import { createHash } from 'node:crypto';
import { canonicalGzip } from '@repo/archive/archive-format';
import { workloadIdentityToken } from '@repo/archive/federation';
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
import { functionEnvSealer } from '../functions/env.ts';
import { functionsFor } from '../functions/index.ts';
import { GitHubApp } from '../integrations/github/app.ts';
import {
  GitHubAppAuth,
  hasGitHubAppEnvIdentity,
} from '../integrations/github/app-auth.ts';
import { type Fetcher, retryTransient } from '../integrations/github/http.ts';
import { sourceDepotFor, stageArchiveBytes } from '../storage/archives.ts';
import { buildOutbox } from '../storage/build-outbox.ts';
import { cachedBundle, rememberBundle } from '../storage/bundle-cache.ts';
import { registryCredentialStore } from '../storage/registry-credentials.ts';
import { CoreSupplyChain, CosignSigner } from '../supply-chain/sign.ts';
import { SpindriftSignatureVerifier } from '../supply-chain/signature.ts';
import { SlsaVerifier } from '../supply-chain/verify.ts';
import type { BosunOutbox } from './build/bosun.ts';
import type { BuildAdapter } from './build/contract.ts';
import { findBuildRouteDescriptor } from './build/descriptors.ts';
import { GcpDiscovery } from './cloud-discovery.ts';
import { type CloudflareAccounts, cloudflareAccounts } from './cloudflare.ts';
import type { DatastoreAdapter } from './datastore/contract.ts';
import { CloudDatastoreAdapter } from './datastore/gcp.ts';
import { KubernetesDatastoreAdapter } from './datastore/kubernetes.ts';
import { CloudRunDeployAdapter } from './deploy/cloudrun/index.ts';
import type { DeployAdapter } from './deploy/contract.ts';
import { KubernetesApi, type TokenProvider } from './deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from './deploy/kubernetes/index.ts';
import { PagesDeployAdapter } from './deploy/pages/index.ts';
import { StaticDeployAdapter } from './deploy/static/index.ts';
import {
  DEFAULT_ENDPOINT as VERCEL_DEFAULT_ENDPOINT,
  VercelDeployAdapter,
} from './deploy/vercel/index.ts';
import { ClusterDnsPublisher } from './dns/cluster.ts';
import type { DnsPublisher } from './dns/contract.ts';
import type { SecretStore } from './store/contract.ts';
import {
  DEFAULT_ENDPOINT as SECRET_MANAGER_DEFAULT_ENDPOINT,
  SecretManagerStore,
} from './store/gcp-secret-manager.ts';
import { OnePasswordStore } from './store/onepassword.ts';
import { VercelSecretStore } from './store/vercel.ts';

export const SERVICE_ACCOUNT_TOKEN_PATH =
  '/var/run/secrets/kubernetes.io/serviceaccount/token';
/** Installer-declared path for the reconciler's audience-scoped token. */
export const IDENTITY_TOKEN_PATH_VAR = 'SPINDRIFT_IDENTITY_TOKEN_PATH';

export class AdapterUnavailableError extends Error {
  override readonly name = 'AdapterUnavailableError';
}

/** Reads the token file on every call, since the kubelet rotates it. */
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
 * The installer's audience-scoped token, or the default service account path
 * outside the chart.
 */
export function installationServiceAccountToken(
  env: Record<string, string | undefined> = Bun.env,
): TokenProvider {
  const configured = env[IDENTITY_TOKEN_PATH_VAR]?.trim();
  return projectedServiceAccountToken(configured || SERVICE_ACCOUNT_TOKEN_PATH);
}

export interface RegistryOptions {
  readonly manifest: InstallationManifest;
  /** Without it, no GitHub App identity, registry credentials or build outbox. */
  readonly db?: Database;
  /** Shared with commands so token expiry and rows agree on one time source. */
  readonly clock?: import('../commands/types.ts').Clock;
  /** The cluster token; defaults to the projected service account token. */
  readonly token?: TokenProvider;
  readonly fetch?: Fetcher;
  /** Defaults to the process environment. */
  readonly env?: Record<string, string | undefined>;
  /** Defaults by store adapter; see {@link storeTokenFor}. */
  readonly storeToken?: () => string | Promise<string>;
  readonly vercelToken?: TokenProvider;
  readonly cloudflareToken?: TokenProvider;
  /** One federated token for cloud runtimes and the cloud build service. */
  readonly cloudToken?: () => string | Promise<string>;
  /** Replaces the default repository source stager. */
  readonly source?: RepositorySourceStager;
}

/**
 * Adapters are built once and shared: they hold no per-request state, and each
 * credential is a provider called per request.
 */
export function createAdapterRegistry(
  options: RegistryOptions,
): AdapterRegistry {
  const kubernetes = new KubernetesDeployAdapter({
    chart: options.manifest.charts.app,
    token:
      options.token ?? installationServiceAccountToken(options.env ?? Bun.env),
  });

  // One publisher on the control-plane cluster, since a platform-named Target
  // has no cluster. This process runs there, so the same token reaches it.
  const dns = controlPlaneDnsPublisher(
    options.manifest,
    options.token ?? installationServiceAccountToken(options.env ?? Bun.env),
    options.fetch,
  );

  // The App identity comes from the installation Secret or the sealed
  // `github_app` row, read per mint: setup writes the row while this runs.
  const env = options.env ?? Bun.env;
  const keyring = CredentialKeyring.fromEnvironment(env);
  const appAuth =
    options.db !== undefined &&
    (keyring !== null || hasGitHubAppEnvIdentity(env))
      ? new GitHubAppAuth({
          db: options.db,
          clock: options.clock ?? { now: () => new Date() },
          keyring,
          env,
          apiBaseUrl: options.manifest.github.apiBaseUrl,
          webBaseUrl: options.manifest.github.webBaseUrl,
          controlPlaneHostname: options.manifest.controlPlane.hostname,
          installationName: options.manifest.installation.name,
          appSlug: options.manifest.github.appSlug ?? null,
          webhookUrl: options.manifest.github.webhookUrl ?? null,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      : null;
  // The concrete type, because the hosted build route needs Actions calls
  // beyond `RepositoryHost`.
  const app =
    appAuth === null
      ? null
      : new GitHubApp({
          baseUrl: options.manifest.github.apiBaseUrl,
          authorization: (ref) => appAuth.authorization(ref),
          appAuthorization: () => appAuth.appAuthorization(),
          ...(options.manifest.github.accounts
            ? { recognizedAccounts: options.manifest.github.accounts }
            : {}),
          onUnauthorized: (ref, authorization) =>
            appAuth.rejectedAuthorization(ref, authorization),
          principalSubject: (ref) => appAuth.principalSubject(ref),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  const repositoryHost: RepositoryHost | null = app;
  const repositoryAuthorization: RepositoryAuthorization | null =
    appAuth === null || app === null
      ? null
      : {
          status: () => appAuth.status(),
          setup: (userId) => appAuth.setup(userId),
          repositories: () => app.availableRepositories(),
          installationFor: (fullName) => app.installationFor(fullName),
        };
  // A cloud API refuses the projected cluster token with a 401, so this is a
  // federated one. Resolved first because the cloud build route uses it too.
  const cloud = cloudTokenFor(options);

  const store = createSecretStore(
    options.manifest,
    options.storeToken ?? storeTokenFor(options.manifest, cloud, options.env),
    options.fetch,
  );

  // Beside the manifest's store, since each Target reaches its own. `null` when
  // no team is named.
  const team = vercelTeam(options.env ?? Bun.env);
  const vercelStore =
    team === null
      ? null
      : new VercelSecretStore({
          baseUrl: VERCEL_DEFAULT_ENDPOINT,
          token: options.vercelToken ?? vercelToken(options.env ?? Bun.env),
          team,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
  const supplyChain = new CoreSupplyChain(
    new SlsaVerifier(),
    new CosignSigner({ key: options.manifest.supplyChain.signer }),
    // Admission re-verifies the recorded signature against the recorded digest,
    // pinned to the manifest's signer.
    new SpindriftSignatureVerifier({
      signerKey: options.manifest.supplyChain.signer,
    }),
  );

  const discovery = new GcpDiscovery({
    token: cloud,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  const cloudflare = cloudflareAccounts({
    token: options.cloudflareToken ?? cloudflareToken(options.env ?? Bun.env),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });

  // The bosun route claims against durable state: no database, no outbox.
  const outbox =
    options.db === undefined
      ? null
      : buildOutbox(options.db, () =>
          (options.clock ?? { now: () => new Date() }).now(),
        );

  // The manifest's order is the admin rank; `buildRouteProfiles` reads it the
  // same way.
  const buildRoutes = new Map<string, BuildAdapter>();
  for (const route of options.manifest.build.routes) {
    const built = createBuildRoute(route, options, app, cloud, outbox);
    if (built !== null) buildRoutes.set(route.name, built);
  }

  // Each Target's connection carries its own endpoint and project, so one
  // instance per adapter serves every Target.
  const deployAdapters: Partial<Record<TargetAdapter, DeployAdapter>> = {
    kubernetes,
    cloudrun: new CloudRunDeployAdapter({
      token: cloud,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    static: new StaticDeployAdapter({
      token: cloud,
      // A supplied upload is a `gs://` object, read by a URL signed with the
      // federation itself, before impersonation.
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    // The edge backends drive the platform with its own bearer and read the
    // artifact registry with the federated token.
    vercel: new VercelDeployAdapter({
      token: options.vercelToken ?? vercelToken(options.env ?? Bun.env),
      artifactToken: cloud,
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    'cloudflare-pages': new PagesDeployAdapter({
      token: options.cloudflareToken ?? cloudflareToken(options.env ?? Bun.env),
      artifactToken: cloud,
      federation: options.manifest.cloud.federation,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  };

  // Absent adapters answer `null`: static hosting has no runtime to dial a
  // datastore from.
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

    /** An unknown route and one this process cannot construct both answer `null`. */
    build(route: string): BuildAdapter | null {
      return buildRoutes.get(route) ?? null;
    },

    store(adapter: StoreAdapter): SecretStore | null {
      // A Vercel Target's functions read no reference, so only the platform's
      // own environment can deliver to them, whatever the manifest selects.
      if (adapter === 'vercel') return vercelStore;
      return adapter === options.manifest.secretStore.adapter ? store : null;
    },

    /** `null` when the installation has no GitHub App identity. */
    repository(): RepositoryHost | null {
      return repositoryHost;
    },

    registryTransport() {
      return options.fetch ?? fetch;
    },

    /** `null` without both a database and a keyring: no token is kept in clear. */
    registryCredentials() {
      const now = () => (options.clock ?? { now: () => new Date() }).now();
      // Stored rows only: GHCR accepts no App installation token, only classic
      // PATs and an Actions run's own `GITHUB_TOKEN`.
      return keyring === null || options.db === undefined
        ? null
        : registryCredentialStore(options.db, keyring, now);
    },

    source() {
      if (options.source !== undefined) return options.source;
      if (app === null) return null;
      // Commits stage into the same durable depot as uploads, since a hosted
      // runner cannot fetch a bundle from this pod's disk.
      const depot = sourceDepotFor(options.manifest);
      const db = options.db;
      const defaultSourceStager: RepositorySourceStager = {
        async stageRepository(input) {
          // The depot is content-addressed, so a staged commit is reused, not
          // refetched once per App on a push. Its source receipt is already stored.
          const cached =
            db === undefined || depot === null
              ? null
              : await cachedBundle(db, depot, input.repository, input.commit);
          if (cached !== null) return cached;

          const staged = await stageSourceBundle(
            {
              kind: 'git',
              repository: input.repository,
              commit: input.commit,
              credential: input.ref,
            },
            {
              // The host's gzip wrapper differs between fetches, so it is
              // reframed deterministically before the digest is taken.
              fetcher: {
                async fetchExactCommit(fetchInput) {
                  // Retried here, at the download: both callers turn a failure
                  // into a `NOT_BUILDABLE` an operator must clear by hand.
                  const fetched = await retryTransient(() =>
                    app.fetchExactCommit(fetchInput),
                  );
                  return { ...fetched, bytes: canonicalGzip(fetched.bytes) };
                },
              },
              depot: {
                async putImmutable(item) {
                  const archived = await stageArchiveBytes(
                    // The host's tarball endpoint answers with a gzipped tar,
                    // and the reusable workflow runs `tar -xz`.
                    `bundle-${item.digest.replace('sha256:', '')}.tgz`,
                    item.bytes,
                    depot,
                    // The declared retention routes the bundle under the expiring prefix.
                    item.retention,
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
          if (db !== undefined && depot !== null) {
            await rememberBundle(
              db,
              input.repository,
              input.commit,
              staged.bundle,
              input.stagedAt,
            );
          }
          return staged.bundle;
        },
      };
      return defaultSourceStager;
    },

    repositoryAuthorization(): RepositoryAuthorization | null {
      return repositoryAuthorization;
    },

    /**
     * Shares `cloud` and its token cache. Without federation the provider
     * refuses, so the screen says why a cloud is unreachable.
     */
    discovery(): GcpDiscovery {
      return discovery;
    },

    /** Reads a connected Cloudflare account, on the bearer its surfaces use. */
    cloudflare(): CloudflareAccounts {
      return cloudflare;
    },

    functions() {
      return functionsFor({
        manifest: options.manifest,
        cloudflareToken:
          options.cloudflareToken ?? cloudflareToken(options.env ?? Bun.env),
        cloudToken: cloud,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },

    /** Needs only a keyring: the sealed envelope lives on the function's row. */
    functionEnv() {
      return keyring === null ? null : functionEnvSealer(keyring);
    },

    supplyChain() {
      return supplyChain;
    },

    dns(): DnsPublisher | null {
      return dns;
    },
  };
}

/**
 * The configured build routes in rank order, including any this process cannot
 * construct, so placement can say why one is unavailable.
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
 * The DNS publisher on the control-plane vessel's Kubernetes Target, from the
 * manifest seed. `null` when the manifest gives that Target no `connection` or
 * its vessel no `location`.
 */
function controlPlaneDnsPublisher(
  manifest: InstallationManifest,
  token: TokenProvider,
  fetch?: Fetcher,
): DnsPublisher | null {
  const target = manifest.targets.find(
    (candidate) =>
      candidate.vessel === manifest.installation.controlPlaneVessel &&
      candidate.adapter === 'kubernetes',
  );
  // `.find` does not narrow the union, so the adapter is checked again.
  if (target === undefined || target.adapter !== 'kubernetes') return null;
  if (target.connection === undefined) return null;

  const vessel = manifest.vessels.find(
    (candidate) => candidate.name === target.vessel,
  );
  if (vessel === undefined || vessel.kind !== 'cluster') return null;
  if (vessel.location === undefined) return null;

  return new ClusterDnsPublisher({
    api: new KubernetesApi({
      apiServer: vessel.location.apiServer,
      token,
      ...(fetch === undefined ? {} : { fetch }),
    }),
    // The namespace the cluster's GitOps operator already reconciles, not the
    // Target's catch-all `namespace`.
    namespace: target.connection.delivery.namespace,
  });
}

/**
 * Cloud APIs are reached by federation, never a stored credential. Without it
 * the provider refuses, so a cloud Target still connects and says why.
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

/** The 1Password Connect bearer, read per call so a rotated Secret applies. */
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
 * The Vercel bearer, read per call like {@link storeToken}. Vercel offers no
 * inbound federation, so this is a long-lived operator token.
 */
export const VERCEL_TOKEN_VARIABLE = 'SPINDRIFT_VERCEL_TOKEN';

/**
 * The team the Vercel config store writes in. Deploys use each Target's own
 * team, so a Target on another team deploys but holds no config. Unset, there
 * is no Vercel store.
 */
export const VERCEL_TEAM_VARIABLE = 'SPINDRIFT_VERCEL_TEAM';

export function vercelTeam(
  env: Record<string, string | undefined> = Bun.env,
): string | null {
  return env[VERCEL_TEAM_VARIABLE]?.trim() || null;
}

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
 * The Cloudflare account bearer, read per call like {@link vercelToken}. Scope it
 * to the hosting product only: core reaches no zone with it.
 * ponytail: one account per installation. Move it to a per-vessel sealed row
 * when a second account is needed.
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
 * The store's credential follows the store: a Connect bearer from the Secret,
 * or the federated token for Secret Manager, whose hour-long tokens a Secret
 * could not hold fresh.
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

/**
 * The manifest's store. Secret Manager's endpoint defaults to its one API host;
 * a self-hosted Connect server has none, so a missing endpoint is refused here.
 */
export function createSecretStore(
  manifest: InstallationManifest,
  token: () => string | Promise<string> = storeToken(),
  fetch?: Fetcher,
): SecretStore {
  // The home vessel's container: the store of record lives in one place.
  const { secretStoreContainer } = sharedServicesOf(manifest);
  const adapter = manifest.secretStore.adapter satisfies StoreAdapter;
  const baseUrl =
    manifest.secretStore.endpoint ??
    (adapter === 'gcp-secret-manager' ? SECRET_MANAGER_DEFAULT_ENDPOINT : null);
  if (baseUrl === null) {
    throw new Error(
      'this installation’s secretStore has no endpoint, and the onepassword ' +
        'adapter has no default for it — a self-hosted Connect server has no ' +
        'universal address to assume',
    );
  }
  const endpoint = { baseUrl, token, ...(fetch ? { fetch } : {}) };
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
