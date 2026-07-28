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
import type { StoreAdapter, TargetAdapter } from '../config/manifest.schema.ts';
import type { InstallationManifest } from '../config/manifest.ts';
import type { RepositoryHost } from '../domain/repository.ts';
import { GitHubApp } from '../integrations/github/app.ts';
import type { Fetcher } from '../integrations/github/http.ts';
import type { BuildAdapter } from './build/contract.ts';
import type { DeployAdapter } from './deploy/contract.ts';
import type { TokenProvider } from './deploy/kubernetes/api.ts';
import { KubernetesDeployAdapter } from './deploy/kubernetes/index.ts';
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
 * Where the GitHub App's private key is read from (§15: "bootstrapped from a
 * SOPS Secret").
 *
 * An environment variable rather than a manifest key, and the split is the one
 * §20 already draws: the manifest is non-secret installation configuration and
 * is rendered into a ConfigMap, while this is the one long-lived credential
 * this integration has. An installation without it simply has no repository
 * integration — which is a supported installation, because §2's other source is
 * an uploaded archive.
 */
export const GITHUB_APP_KEY_VAR = 'SPINDRIFT_GITHUB_APP_KEY';

export interface RegistryOptions {
  readonly manifest: InstallationManifest;
  /** Injected so a test can stand a fake far side behind the real client. */
  readonly token?: TokenProvider;
  /** Injected for the same reason, for the repository host's transport. */
  readonly fetch?: Fetcher;
  /** Defaults to the process environment; a test passes its own. */
  readonly env?: Record<string, string | undefined>;
  /** Likewise for the store's own access path, which authorizes separately. */
  readonly storeToken?: () => string | Promise<string>;
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
    token: options.token ?? projectedServiceAccountToken(),
  });

  // §15's repository host, when this installation was given the App key. Built
  // once: it caches the imported signing key and one installation token per
  // installation, and a per-request instance would mint a JWT per call.
  const appKey = (options.env ?? Bun.env)[GITHUB_APP_KEY_VAR]?.trim();
  const repositoryHost: RepositoryHost | null = appKey
    ? new GitHubApp({
        appId: options.manifest.github.appId,
        privateKeyPem: appKey,
        baseUrl: options.manifest.github.apiBaseUrl,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : null;
  const store = createSecretStore(
    options.manifest,
    options.storeToken ?? storeToken(options.env ?? Bun.env),
  );

  const deployAdapters: Partial<Record<TargetAdapter, DeployAdapter>> = {
    kubernetes,
    // `cloudrun` and `static` arrive with Milestone 5. Absent rather than
    // stubbed: a stub would make a Target of that type look placeable and fail
    // at apply, which is precisely the "why can I not deploy here" §13 wants
    // answered on the Target instead.
  };

  return {
    deploy(adapter: TargetAdapter): DeployAdapter | null {
      return deployAdapters[adapter] ?? null;
    },

    /**
     * No build route exists yet (Milestone 4).
     *
     * §4 makes the set of routes an installation's configuration rather than a
     * closed vocabulary, so "this installation has no build route named X" is
     * already the sentence `dispatchBuild` prints for every name — including,
     * for now, all of them. An archive of finished output still deploys,
     * because a supplied artifact consults no route at all.
     */
    build(_route: string): BuildAdapter | null {
      return null;
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
     * §15's repository host, or `null` when no App key was supplied.
     *
     * `null` rather than a throw, following the same rule the other lookups
     * do: an installation with no repository integration is a configuration
     * fact, and `connectRepository` reports it as a refusal an operator can
     * act on.
     */
    repository(): RepositoryHost | null {
      return repositoryHost;
    },
  };
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
