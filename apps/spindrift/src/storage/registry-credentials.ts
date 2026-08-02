/**
 * The registry push credentials this installation holds (§16).
 *
 * §13's "native OIDC federation, nothing stored" is the rule, and this is the
 * named exception to it. It exists because the rule has a gap the rule cannot
 * close: a push authorizes as the route that makes it — a projected service
 * account token in-cluster, a federated token for the cloud builder — and
 * **Docker Hub trusts neither**. There is no federation to configure; the
 * registry takes a username and a token or it takes nothing.
 *
 * So the exception is drawn as narrowly as the thing it is for:
 *
 * - **One row per host**, not per namespace. A login authenticates a registry.
 * - **Sealed with the same keyring** the GitHub OAuth credential uses, so
 *   rotation is the two-PR dance already documented rather than a second one.
 * - **No read verb above this seam.** {@link RegistryCredentialStore} has
 *   `authFor`, which opens envelopes for a dispatch that is about to happen,
 *   and `list`, which returns usernames and never secrets. A command cannot ask
 *   for a token because the contract has no way to answer.
 * - **Opened at dispatch and nowhere else.** The plaintext lives for the length
 *   of one build request and is never written to a row, a log, or an event.
 *
 * The honest cost, stated rather than mitigated: a credential handed to a
 * builder is a credential that builder holds. What this bounds is *which*
 * builders — see `carriesRegistryCredential` on the build contract, and the
 * refusal `dispatchBuild` makes for a route that is not one of them.
 */
import { eq, inArray } from 'drizzle-orm';
import type { CredentialKeyring } from '../crypto/credential-envelope.ts';
import type { Database } from '../db/client.ts';
import { registryCredentials } from '../db/schema.ts';

/** The purpose every registry envelope is sealed under. */
export const REGISTRY_CREDENTIAL_PURPOSE = 'spindrift-registry-credential';

/** What a builder is handed to authenticate one registry. */
export interface RegistryAuth {
  readonly host: string;
  readonly username: string;
  /** Plaintext, for the length of one dispatch. Never persisted in this form. */
  readonly secret: string;
}

/** What a listing may know: who, and when — never the token. */
export interface RegistryCredentialSummary {
  readonly host: string;
  readonly username: string;
  readonly updatedAt: Date;
}

/**
 * The far side of the credential table.
 *
 * A seam rather than direct table access from the commands, for the reason the
 * command layer states about everything else it reaches: the keyring comes from
 * the process environment, and a command reading it would be a command reading
 * a module singleton the context exists to remove.
 */
export interface RegistryCredentialStore {
  /** Seal and store one host's credential, replacing whatever was there. */
  put(input: {
    readonly host: string;
    readonly username: string;
    readonly secret: string;
  }): Promise<void>;
  /** Forget one host's credential. `false` when there was none. */
  forget(host: string): Promise<boolean>;
  /** Every host that has one, with no secret in the answer. */
  list(): Promise<readonly RegistryCredentialSummary[]>;
  /**
   * Open the credentials for these hosts, for a dispatch about to happen.
   *
   * Hosts with no credential are simply absent — a registry the route's own
   * identity already reaches is the ordinary case, not a missing row.
   */
  authFor(hosts: readonly string[]): Promise<readonly RegistryAuth[]>;
}

/** The store an installation with a keyring has. */
export function registryCredentialStore(
  db: Database,
  keyring: CredentialKeyring,
  now: () => Date = () => new Date(),
): RegistryCredentialStore {
  return {
    async put({ host, username, secret }) {
      const sealed = await keyring.seal(secret, REGISTRY_CREDENTIAL_PURPOSE);
      await db
        .insert(registryCredentials)
        .values({ host, username, secret: sealed })
        .onConflictDoUpdate({
          target: registryCredentials.host,
          set: { username, secret: sealed, updatedAt: now() },
        });
    },

    async forget(host) {
      const gone = await db
        .delete(registryCredentials)
        .where(eq(registryCredentials.host, host))
        .returning({ host: registryCredentials.host });
      return gone.length > 0;
    },

    async list() {
      const rows = await db
        .select({
          host: registryCredentials.host,
          username: registryCredentials.username,
          updatedAt: registryCredentials.updatedAt,
        })
        .from(registryCredentials);
      return rows;
    },

    async authFor(hosts) {
      if (hosts.length === 0) return [];
      const rows = await db
        .select()
        .from(registryCredentials)
        .where(inArray(registryCredentials.host, [...hosts]));

      const opened: RegistryAuth[] = [];
      for (const row of rows) {
        // An envelope this keyring cannot open is a rotation that dropped a
        // legacy key too early. It throws rather than being skipped: silently
        // dispatching without a credential turns a configuration error into an
        // unauthorized push nobody can trace back to here.
        const { plaintext } = await keyring.open(
          row.secret,
          REGISTRY_CREDENTIAL_PURPOSE,
        );
        opened.push({
          host: row.host,
          username: row.username,
          secret: plaintext,
        });
      }
      return opened;
    },
  };
}
