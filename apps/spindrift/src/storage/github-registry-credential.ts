/**
 * GHCR, authorized by the credential this installation already refreshes (§13).
 *
 * §16 draws `registry_credentials` as a narrow exception to §13's "nothing
 * stored", and the honest cost of that exception is a long-lived token in a
 * database: it does not rotate, it does not expire, and nothing notices when it
 * should have been revoked. Where a registry has no federation that is the only
 * option. GHCR is not one of those registries.
 *
 * Spindrift already holds a GitHub credential that refreshes itself — the
 * device-flow authorization behind `GitHubDeviceOAuth`, sealed with the
 * installation keyring, renewed on expiry, and revocable from GitHub. GHCR
 * authenticates with a GitHub token. So the credential a cloud build needs to
 * push to GHCR is one this process can *mint per dispatch* rather than one an
 * operator has to paste in and then own forever.
 *
 * **Nothing new is stored.** This holds no row of its own; it answers `authFor`
 * from the OAuth credential at the moment a dispatch asks, which is the same
 * lifetime every other §13 identity has.
 *
 * **The prerequisite is on GitHub's side and cannot be arranged from here.** A
 * user-to-server token reaches a package only where the App has `packages:
 * write` *and* the package itself grants that App access — both of which are
 * settings in GitHub's UI. Until they are, this mints a credential that GHCR
 * refuses. That is why it is wired to be *checkable*: `testRegistryReachability`
 * exercises whatever `authFor` returns, so `ghcr.io/<owner>` comes back
 * authenticated or refused before anything relies on it. Confirm it there once,
 * rather than learning it from a build that failed at the export.
 *
 * A stored row for the same host **wins**. An operator who has pasted a token
 * has said something more specific than this default, and quietly overriding it
 * would make a deliberate act look broken.
 */
import type {
  RegistryAuth,
  RegistryCredentialStore,
  RegistryCredentialSummary,
} from './registry-credentials.ts';

/** The registry a GitHub token authenticates. */
export const GHCR_HOST = 'ghcr.io';

/** As much of the OAuth connector as minting a registry credential needs. */
export interface GitHubRegistryIdentity {
  /** `<type> <token>`, refreshed — the same value every API call carries. */
  authorization(): Promise<string>;
  /**
   * Who the credential belongs to, for the registry's username field.
   *
   * `login` is present exactly when the state is `authorized` — the connector
   * writes both from one row — so there is no fallback username here. A status
   * that names nobody is a connector that cannot mint, which is the same answer
   * as an unauthorized one.
   */
  status(): Promise<{ state: string; login?: string }>;
}

/**
 * The installation's credential store, plus GHCR minted from GitHub.
 *
 * Returns `base` unchanged when there is no GitHub credential to mint from, so
 * an installation without the connector is exactly what it was.
 */
export function withGitHubRegistryCredential(
  base: RegistryCredentialStore | null,
  github: GitHubRegistryIdentity | null,
  now: () => Date = () => new Date(),
): RegistryCredentialStore | null {
  if (github === null) return base;

  /** The minted credential, or null when GitHub is not authorized. */
  async function minted(): Promise<RegistryAuth | null> {
    try {
      const status = await github?.status();
      if (status?.state !== 'authorized') return null;
      const username = status.login;
      if (username === undefined || username === '') return null;
      const authorization = await github?.authorization();
      if (authorization === undefined) return null;
      // `authorization()` answers in `Authorization:` header form. The registry
      // wants the token alone, in the password field.
      const secret = authorization.replace(/^[^ ]+ +/, '');
      if (secret === '') return null;
      return { host: GHCR_HOST, username, secret };
    } catch {
      // A connector that needs reauthorization is not an error here: it is one
      // fewer registry this route can push to, which `publishableRegistries`
      // already knows how to say.
      return null;
    }
  }

  return {
    put: (input) =>
      base?.put(input) ??
      Promise.reject(
        new Error(
          'this installation has nowhere to store a registry credential',
        ),
      ),

    forget: (host) => base?.forget(host) ?? Promise.resolve(false),

    async list(): Promise<readonly RegistryCredentialSummary[]> {
      const stored = (await base?.list()) ?? [];
      if (stored.some((one) => one.host === GHCR_HOST)) return stored;
      const auth = await minted();
      if (auth === null) return stored;
      return [
        ...stored,
        { host: GHCR_HOST, username: auth.username, updatedAt: now() },
      ];
    },

    async authFor(hosts): Promise<readonly RegistryAuth[]> {
      const stored = (await base?.authFor(hosts)) ?? [];
      if (
        !hosts.includes(GHCR_HOST) ||
        stored.some((one) => one.host === GHCR_HOST)
      ) {
        return stored;
      }
      const auth = await minted();
      return auth === null ? stored : [...stored, auth];
    },
  };
}
