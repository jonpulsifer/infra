/**
 * Durable storage for the declared installation manifest.
 *
 * Parsing and validation stay in `manifest.ts`; this module owns the singleton
 * row and reconciles a deployment declaration — including ordered Target
 * identities — into durable state.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { installation, targets } from '../db/schema.ts';
import { unreachablePrerequisites } from '../domain/capabilities.ts';
import type { TargetConnection } from '../domain/target.ts';
import type {
  AuthoredManifest,
  InstallationManifest,
  TargetSeed,
} from './manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  loadManifestIfPresent,
  ManifestError,
  resolveManifest,
  validateManifest,
} from './manifest.ts';

type Env = Record<string, string | undefined>;

/**
 * Load the durable singleton, seeding it from a declaration when it is empty.
 *
 * **A declaration seeds; it does not govern.** The stored row wins whenever one
 * exists, because configuration is the UI's to drive and a rollout must not
 * revert what an operator just configured. A mounted file or inline env
 * document is therefore consulted only for an unseeded installation, ahead of
 * the high-trust placeholder — which is what makes a torn-down installation
 * come back configured without anyone opening a browser.
 *
 * The cost is that editing a declaration does nothing to an installation that
 * already has a row, so an ignored declaration says so at startup rather than
 * being quietly skipped. Re-seeding is deliberate: discard the row.
 *
 * What is written is the authored document; what is returned has the
 * deployment's own facts resolved onto it. The row therefore never holds a
 * second copy of something the deployment declares — which is the whole of why
 * the two types are different.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const stored = await readStoredManifest(db);
  const declaration = await declaredManifest(stored !== null, env);
  if (stored !== null && declaration !== null) {
    console.warn(
      'installation manifest: a declaration is mounted but this installation is already seeded, so the stored manifest is being used and the declaration is ignored — discard the row to re-seed from it',
    );
  }
  const declared = stored ?? declaration ?? DEFAULT_PLACEHOLDER_MANIFEST;
  await writeStoredManifest(db, declared);
  return resolveManifest(declared, env);
}

/**
 * The mounted declaration, and `null` for one a **seeded** installation cannot
 * parse.
 *
 * A declaration seeds and does not govern, so on an installation that already
 * has a row it is read, announced as ignored, and thrown away. Validating it
 * strictly on that path meant a document this build could not parse took the
 * process down — over a value it had already decided not to use.
 *
 * That is not hypothetical. A manifest key added to the declaration ahead of
 * the image that understands it is the ordinary shape of a rollout: the
 * declaration lands with the merge and the image lands with the digest bump,
 * and between them every replica crash-loops on
 * `Unrecognized key` for a field the stored row does not have and no reader
 * would have consulted. Nothing about the running installation was wrong.
 *
 * **Unseeded is still fatal**, and has to be: there the declaration is the
 * whole configuration, and continuing would boot the placeholder manifest as
 * though the operator had declared nothing.
 *
 * The cost, stated: a declaration that has been broken for a while is a
 * warning nobody reads until a torn-down installation fails to come back
 * configured. That is the smaller failure. Crashing a healthy installation to
 * report a document it is ignoring is the larger one.
 */
async function declaredManifest(
  seeded: boolean,
  env: Env,
): Promise<AuthoredManifest | null> {
  try {
    return await loadManifestIfPresent(env);
  } catch (cause) {
    if (!seeded) throw cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    console.warn(
      `installation manifest: the mounted declaration is not valid for this build and is being ignored, which is what a declaration already is for a seeded installation — re-seeding from it would fail until it is corrected: ${detail}`,
    );
    return null;
  }
}

/**
 * Write the durable singleton and reconcile what it declares, atomically.
 *
 * The seed path and the configure command are the same act — a manifest becomes
 * this installation's — and the Target reconciliation below is why they must not
 * be two implementations. A write that skipped it would leave a Target declared
 * in the document and absent from the table, which is the state no reader
 * checks for because nothing has ever produced it.
 *
 * One transaction, so an incompatible Target cannot leave a half-configured
 * installation behind: the manifest and the Targets it names land together or
 * neither does.
 */
export async function writeStoredManifest(
  db: Database,
  manifest: AuthoredManifest,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(installation).values({ manifest }).onConflictDoUpdate({
      target: installation.id,
      set: { manifest },
    });
    await reconcileManifestTargets(tx, manifest);
  });
}

/**
 * The manifest this installation currently has, or `null` if it has none.
 *
 * Read-only, unlike {@link loadStoredManifest}, which seeds and reconciles.
 * That distinction is the whole reason this is exported: a process that wants
 * to know whether configuration changed asks this on every command, and running
 * a transaction to answer a question would make the asking too expensive to do.
 */
export async function currentStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest | null> {
  const stored = await readStoredManifest(db);
  return stored === null ? null : resolveManifest(stored, env);
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
  manifest: AuthoredManifest,
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
      !Bun.deepEquals(existing?.connection, declaredConnection, true);

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
        ...assertedBySeed(target),
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

/**
 * The asserted columns a seed declares, if it declares any.
 *
 * Omitted rather than nulled when absent, so a declaration that says nothing
 * about reach leaves whatever an operator asserted through the UI standing —
 * the same "a declaration seeds, it does not govern" rule the connection follows.
 */
function assertedBySeed(target: TargetSeed): {
  reaches?: ('none' | 'private' | 'public')[];
  authReaches?: ('none' | 'private' | 'public')[];
} {
  if (target.adapter !== 'kubernetes') return {};
  return {
    ...(target.reaches === undefined ? {} : { reaches: [...target.reaches] }),
    ...(target.authReaches === undefined
      ? {}
      : { authReaches: [...target.authReaches] }),
  };
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

/**
 * The stored document **as authored**, before environment resolution.
 *
 * Exported for the one shape of act that changes a single value and writes the
 * document back. {@link currentStoredManifest} is the wrong input for that: it
 * has already substituted whatever the environment supplied, so writing its
 * result would bake this pod's environment into the durable document and make
 * the next pod's environment stop mattering.
 */
export async function readStoredManifest(
  db: Database,
): Promise<AuthoredManifest | null> {
  const [stored] = await db
    .select({ manifest: installation.manifest })
    .from(installation)
    .limit(1);
  return stored
    ? validateManifest(stored.manifest, 'database installation manifest')
    : null;
}
