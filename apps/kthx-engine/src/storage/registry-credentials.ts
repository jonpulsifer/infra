/**
 * Registry push credentials, one per host, sealed with the installation
 * keyring. Stored because Docker Hub trusts no federated identity. Plaintext
 * leaves only through `authFor`, for a dispatch.
 */
import { eq, inArray } from 'drizzle-orm';
import type { CredentialKeyring } from '../crypto/credential-envelope.ts';
import type { Database } from '../db/client.ts';
import { registryCredentials } from '../db/schema.ts';

/** Bound into each envelope: changing it orphans every stored credential. */
export const REGISTRY_CREDENTIAL_PURPOSE = 'spindrift-registry-credential';

export interface RegistryAuth {
  readonly host: string;
  readonly username: string;
  /** Plaintext for one dispatch; never persisted in this form. */
  readonly secret: string;
}

export interface RegistryCredentialSummary {
  readonly host: string;
  readonly username: string;
  readonly updatedAt: Date;
}

export interface RegistryCredentialStore {
  /** Replaces any credential already held for the host. */
  put(input: {
    readonly host: string;
    readonly username: string;
    readonly secret: string;
  }): Promise<void>;
  /** `false` when there was none. */
  forget(host: string): Promise<boolean>;
  list(): Promise<readonly RegistryCredentialSummary[]>;
  /**
   * Hosts with no credential are left out: the route's own identity reaching
   * the registry is the ordinary case.
   */
  authFor(hosts: readonly string[]): Promise<readonly RegistryAuth[]>;
}

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
        // Throws on an envelope the keyring cannot open: dispatching without
        // the credential would surface as an untraceable unauthorized push.
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
