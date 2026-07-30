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
 * should propagate. So the two adapters Milestone 5 will add and the build
 * routes Milestone 4 will add are `null` here today, and every caller already
 * handles that — a Target whose adapter is missing is a non-candidate with a
 * stated reason (§3), which is exactly right for one that is not built yet.
 *
 * §13's one auth mode is why there is no credential in this file: "native OIDC
 * federation, nothing stored." The cluster Spindrift runs on is reached with
 * its own **projected** service account token, read from disk per request
 * because it rotates, and a projected token is not a held credential (§13).
 */

import type { AdapterRegistry } from '../commands/types.ts';
import type {
  BuildRouteConfig,
  StoreAdapter,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import type { Database } from '../db/client.ts';
import type { BuildRouteProfile } from '../domain/build-route.ts';
import type {
  RepositoryAuthorization,
  RepositoryHost,
} from '../domain/repository.ts';
import type { RepositorySourceStager } from '../domain/source-bundle.ts';
import { GitHubApp } from '../integrations/github/app.ts';
import { CredentialKeyring } from '../integrations/github/credential-crypto.ts';
import type { Fetcher } from '../integrations/github/http.ts';
import { GitHubDeviceOAuth } from '../integrations/github/oauth.ts';
import { CoreSupplyChain, CosignSigner } from '../supply-chain/sign.ts';
import { SpindriftSignatureVerifier } from '../supply-chain/signature.ts';
import { SlsaVerifier } from '../supply-chain/verify.ts';
import { CloudBuildRoute } from './build/cloud-build.ts';
import type { BuildAdapter } from './build/contract.ts';
import { GitHubActionsBuildRoute } from './build/github-actions.ts';
import { InClusterBuildRoute } from './build/in-cluster.ts';
import { workloadIdentityToken } from './deploy/cloud/federation.ts';
import { CloudRunDeployAdapter } from './deploy/cloudrun/index.ts';
import type { DeployAdapter } from './deploy/contract.ts';
import { KubernetesApi, type TokenProvider } from './deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from './deploy/kubernetes/index.ts';
import { StaticDeployAdapter } from './deploy/static/index.ts';
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
  /** And for the cloud builder's, which authorizes separately again. */
  readonly buildToken?: () => string | Promise<string>;
  /** And for the cloud runtimes a Target is deployed to. */
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
  const store = createSecretStore(
    options.manifest,
    options.storeToken ?? storeToken(options.env ?? Bun.env),
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

  // §16's ordered list: the manifest's order *is* the admin rank, so the map is
  // built from it in order and `buildRouteProfiles` reads it back the same way.
  const buildRoutes = new Map<string, BuildAdapter>();
  for (const route of options.manifest.build.routes) {
    const built = createBuildRoute(route, options, app);
    if (built !== null) buildRoutes.set(route.name, built);
  }

  // The two cloud adapters hold no per-Target state either: each Target's
  // connection carries its own endpoint and project, so one instance drives
  // every connected project the same way the cluster adapter drives every
  // cluster.
  //
  // **Not the projected service account token this cluster is reached with.**
  // That one is minted for this cluster's own API server and a cloud API
  // refuses it; the failure would be a `401` on every cloud deploy, blamed on
  // the Target. What belongs here is a federated token, which is what
  // `cloudTokenFor` mints — see `cloud/federation.ts`.
  const cloud = cloudTokenFor(options);
  const deployAdapters: Partial<Record<TargetAdapter, DeployAdapter>> = {
    kubernetes,
    cloudrun: new CloudRunDeployAdapter({
      token: cloud,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
    static: new StaticDeployAdapter({
      token: cloud,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  };

  return {
    deploy(adapter: TargetAdapter): DeployAdapter | null {
      return deployAdapters[adapter] ?? null;
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

    source() {
      return options.source ?? null;
    },

    repositoryAuthorization(): RepositoryAuthorization | null {
      return repositoryAuthorization;
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
  return manifest.build.routes.map((route) => ({
    name: route.name,
    level: BUILD_ROUTE_LEVELS[route.adapter],
  }));
}

/**
 * Each route kind's profile level (§16).
 *
 * A table rather than a construction, because a level has to be readable
 * *without* building the route: placement asks whether a Target could ever use
 * a route, and building one to find out would mean an installation missing a
 * credential also lost the ability to explain why.
 *
 * Kept in step with the classes themselves by `test/adapters/build-routes.test.ts`,
 * which constructs each one and compares.
 */
const BUILD_ROUTE_LEVELS = {
  'github-actions': 2,
  'cloud-build': 3,
  'in-cluster': 1,
} as const satisfies Record<BuildRouteConfig['adapter'], 1 | 2 | 3>;

/**
 * One configured route, or `null` where this process cannot construct it.
 *
 * The hosted route is the only one that can come back `null`: it runs through
 * the repository host, and an installation with no OAuth store has no repository
 * integration at all (§15). The other two authorize with tokens read at the
 * moment of use, so they construct even where those tokens are absent — and
 * fail loudly on the first build rather than silently at boot.
 */
function createBuildRoute(
  route: BuildRouteConfig,
  options: RegistryOptions,
  app: GitHubApp | null,
): BuildAdapter | null {
  const { manifest } = options;
  const zeroConfigFrontend = manifest.build.zeroConfigFrontend;

  switch (route.adapter) {
    case 'github-actions': {
      const workflow = manifest.github.buildWorkflow;
      // Both halves are §15's: no OAuth-backed host means no repository
      // integration, and no pinned workflow means there is nothing to dispatch.
      // Either way this installation has not finished wiring hosted CI.
      if (app === null || workflow === null) return null;
      return new GitHubActionsBuildRoute({
        name: route.name,
        host: app,
        buildWorkflow: workflow,
        zeroConfigFrontend,
      });
    }
    case 'cloud-build':
      return new CloudBuildRoute({
        name: route.name,
        endpoint: route.endpoint,
        logsEndpoint: route.logsEndpoint,
        project: route.project,
        region: route.region,
        image: route.image,
        zeroConfigFrontend,
        token: options.buildToken ?? buildToken(options.env ?? Bun.env),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    case 'in-cluster':
      return new InClusterBuildRoute({
        name: route.name,
        api: new KubernetesApi({
          apiServer: route.endpoint,
          token:
            options.token ??
            installationServiceAccountToken(options.env ?? Bun.env),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        }),
        namespace: route.namespace,
        image: route.image,
        serviceAccount: route.serviceAccount,
        zeroConfigFrontend,
      });
  }
}

/**
 * The bearer token the cloud build route submits with.
 *
 * A second variable rather than the store's, because they are two access paths
 * to two different services and one value good for both would be a value
 * broader than either needs. Read per call for the same reason the store's is:
 * a value captured at boot stops working the moment the Secret is rotated.
 */
export const BUILD_TOKEN_VARIABLE = 'SPINDRIFT_BUILD_TOKEN';

export function buildToken(env: Record<string, string | undefined> = Bun.env) {
  return (): string => {
    const token = env[BUILD_TOKEN_VARIABLE]?.trim();
    if (!token) {
      throw new AdapterUnavailableError(
        `${BUILD_TOKEN_VARIABLE} is not set: this installation cannot submit a cloud build`,
      );
    }
    return token;
  };
}

/**
 * How this installation reaches a cloud Target's control API.
 *
 * **No credential, in either arm.** §13 settles one auth mode — "native OIDC
 * federation, nothing stored" — and `cloud/federation.ts` is the whole of it:
 * a projected token, exchanged, optionally impersonating. An installation that
 * configured no federation gets a provider that refuses rather than one that is
 * absent, because §13's "connect always succeeds" means a cloud Target still
 * exists and still has to be able to say why it is unreachable.
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
 * The bearer token core writes to the store with.
 *
 * Read per call, never captured: the installation Secret is the only place it
 * lives, and a value read once at boot is a value that stops working the moment
 * the Secret is rotated. The name is the software's, identical in every
 * installation — it names no installation, so it is not a §20 literal.
 *
 * §13's "native OIDC federation, nothing stored" is where this ends up for the
 * cloud store: the pod already projects a token with a cloud audience, and
 * exchanging it belongs with the cloud Targets that need it. Until then the
 * access path is a token the installation Secret carries, which is the same
 * posture the 1Password Connect path has permanently.
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

/** The store this installation's manifest selects, over the path it names. */
export function createSecretStore(
  manifest: InstallationManifest,
  token: () => string | Promise<string> = storeToken(),
): SecretStore {
  const endpoint = { baseUrl: manifest.secretStore.endpoint, token };
  const adapter = manifest.secretStore.adapter satisfies StoreAdapter;
  switch (adapter) {
    case 'onepassword':
      return new OnePasswordStore({
        ...endpoint,
        vault: manifest.secretStore.container,
      });
    case 'gcp-secret-manager':
      return new SecretManagerStore({
        ...endpoint,
        project: manifest.secretStore.container,
      });
  }
}
