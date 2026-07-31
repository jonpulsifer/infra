/**
 * Durable storage for the declared installation manifest.
 *
 * Parsing and validation stay in `manifest.ts`; this module owns the singleton
 * row and reconciles a deployment declaration — including ordered Target
 * identities — into durable state.
 */
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { installation, targets } from '../db/schema.ts';
import { unreachablePrerequisites } from '../domain/capabilities.ts';
import type { TargetConnection } from '../domain/target.ts';
import type { InstallationManifest, TargetSeed } from './manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  loadManifestIfPresent,
  ManifestError,
  validateManifest,
} from './manifest.ts';

type Env = Record<string, string | undefined>;

/**
 * Reconcile declared configuration into the durable singleton, then load it.
 *
 * A mounted file or inline env declaration is reconciled first. Without a
 * file/env declaration, Spindrift reads the stored manifest from Postgres.
 * If the Postgres store is unseeded, Spindrift seeds the high-trust default
 * placeholder manifest so the UI can drive all configuration dynamically.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const declared =
    (await loadManifestIfPresent(env)) ??
    (await readStoredManifest(db)) ??
    DEFAULT_PLACEHOLDER_MANIFEST;

  await db.transaction(async (tx) => {
    await tx
      .insert(installation)
      .values({ manifest: declared })
      .onConflictDoUpdate({
        target: installation.id,
        set: { manifest: declared },
      });
    await reconcileManifestTargets(tx, declared);
  });
  return declared;
}

/**
 * Materialize the manifest's ordered Target identities and declared
 * connections.
 *
 * An omitted connection leaves existing product-owned connection state alone.
 * A declared connection is desired state: it creates a connected row and
 * resets changed connection facts to an unhealthy, awaiting-inspection
 * checklist. A disconnected row stays disconnected until reconciler startup
 * can inspect and safely re-adopt its Deploys. Keeping this work in the manifest
 * transaction means an incompatible target cannot poison the durable
 * declaration.
 */
async function reconcileManifestTargets(
  db: Pick<Database, 'insert' | 'query'>,
  manifest: InstallationManifest,
): Promise<void> {
  for (const [rank, target] of manifest.targets.entries()) {
    const { name, adapter } = target;
    const declaredConnection = connectionFromSeed(target);
    const existing = await db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, name),
    });
    if (existing !== undefined && existing.adapter !== adapter) {
      throw new ManifestError(
        `manifest Target ${name} uses ${adapter}, but the stored Target uses ${existing.adapter}`,
      );
    }

    const awaitingInspection = unreachablePrerequisites(
      'Declared Target connection is awaiting inspection',
      adapter,
    );
    const hasConnectionChange =
      declaredConnection !== null &&
      !isDeepStrictEqual(existing?.connection, declaredConnection);

    await db
      .insert(targets)
      .values({
        name,
        adapter,
        rank,
        status:
          declaredConnection === null
            ? ('disconnected' as const)
            : ('connected' as const),
        connection: declaredConnection,
        health: 'unhealthy' as const,
        prerequisites:
          declaredConnection === null
            ? unreachablePrerequisites(
                'Target connection has not been configured',
                adapter,
              )
            : awaitingInspection,
      })
      .onConflictDoUpdate({
        target: targets.name,
        set: hasConnectionChange
          ? {
              rank,
              ...(existing?.status === 'disconnected'
                ? {}
                : { status: 'connected' as const }),
              connection: declaredConnection,
              health: 'unhealthy' as const,
              prerequisites: awaitingInspection,
              discovery: null,
              inspectedAt: null,
              updatedAt: sql`now()`,
            }
          : { rank },
      });
  }
}

function connectionFromSeed(target: TargetSeed): TargetConnection | null {
  if (target.connection === undefined) return null;
  switch (target.adapter) {
    case 'kubernetes':
      return { adapter: 'kubernetes', ...target.connection };
    case 'cloudrun':
      return { adapter: 'cloudrun', ...target.connection };
    case 'static':
      return { adapter: 'static', ...target.connection };
  }
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
