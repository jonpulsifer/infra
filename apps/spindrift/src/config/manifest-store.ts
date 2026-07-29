/**
 * Postgres ownership of the installation manifest.
 *
 * Parsing and validation stay in `manifest.ts`; this module owns only the
 * singleton row and the one-time transition from bootstrap configuration to
 * durable state.
 */
import type { Database } from '../db/client.ts';
import { installation, targets } from '../db/schema.ts';
import { unreachablePrerequisites } from '../domain/capabilities.ts';
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
  let manifest = stored;
  if (manifest === null) {
    const bootstrap = await loadManifest(env);
    await db
      .insert(installation)
      .values({ manifest: bootstrap })
      .onConflictDoNothing({ target: installation.id });

    manifest = await readStoredManifest(db);
    if (manifest === null) {
      throw new ManifestError(
        'installation manifest bootstrap completed without a stored manifest',
      );
    }
  }

  await seedManifestTargets(db, manifest);
  return manifest;
}

/**
 * Materialize the manifest's ordered Target identities without pretending they
 * are connected.
 *
 * A Target seed carries only a name and adapter. Connection facts remain null
 * until the operator supplies them through `connectTarget`; that command
 * updates this durable row in place and preserves the manifest-established
 * rank. Conflict tolerance makes concurrent web/reconciler startup safe and
 * lets later boots repair a partially completed seed.
 */
async function seedManifestTargets(
  db: Database,
  manifest: InstallationManifest,
): Promise<void> {
  await db
    .insert(targets)
    .values(
      manifest.targets.map((target, rank) => ({
        ...target,
        rank,
        status: 'disconnected' as const,
        connection: null,
        health: 'unhealthy' as const,
        prerequisites: unreachablePrerequisites(
          'Target connection has not been configured',
          target.adapter,
        ),
      })),
    )
    .onConflictDoNothing({ target: targets.name });
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
