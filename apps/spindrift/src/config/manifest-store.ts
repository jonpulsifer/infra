/**
 * Postgres ownership of the installation manifest.
 *
 * Parsing and validation stay in `manifest.ts`; this module owns only the
 * singleton row and the one-time transition from bootstrap configuration to
 * durable state.
 */
import type { Database } from '../db/client.ts';
import { installation } from '../db/schema.ts';
import type { InstallationManifest } from './manifest.schema.ts';
import { loadManifest, ManifestError, validateManifest } from './manifest.ts';

type Env = Record<string, string | undefined>;

/**
 * Load the database-owned manifest, seeding it once from boot configuration.
 *
 * The insert is intentionally conflict-tolerant: `web` and `reconciler` may
 * start together against an empty database. One wins the singleton row and
 * both read that same committed value afterward. Once the row exists, mounted
 * bootstrap configuration is ignored rather than becoming a competing source
 * of desired state.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const stored = await readStoredManifest(db);
  if (stored !== null) return stored;

  const bootstrap = await loadManifest(env);
  await db
    .insert(installation)
    .values({ manifest: bootstrap })
    .onConflictDoNothing({ target: installation.id });

  const seeded = await readStoredManifest(db);
  if (seeded === null) {
    throw new ManifestError(
      'installation manifest bootstrap completed without a stored manifest',
    );
  }
  return seeded;
}

async function readStoredManifest(
  db: Database,
): Promise<InstallationManifest | null> {
  const [stored] = await db
    .select({ manifest: installation.manifest })
    .from(installation)
    .limit(1);
  return stored
    ? validateManifest(stored.manifest, 'database installation manifest')
    : null;
}
