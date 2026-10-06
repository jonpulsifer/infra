/**
 * The installation manifest's singleton row, and the vessel and Target rows a
 * written document reconciles into.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { installation, targets, vessels } from '../db/schema.ts';
import { unreachablePrerequisites } from '../domain/capabilities.ts';
import type { TargetConnection } from '../domain/target.ts';
import type { VesselKind, VesselLocation } from '../domain/vessel.ts';
import {
  type AuthoredManifest,
  type InstallationManifest,
  isDeclaredInstallationVessel,
  type TargetSeed,
} from './manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  resolveManifest,
  validateManifest,
} from './manifest.ts';

type Env = Record<string, string | undefined>;

/**
 * Seeds the placeholder when no row exists. A row this build cannot parse
 * throws: there is no other document to fall back to.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const stored = await readStoredManifest(db);
  const declared = stored ?? DEFAULT_PLACEHOLDER_MANIFEST;
  await writeStoredManifest(
    db,
    declared,
    stored === null ? 'declared' : 'booted',
  );
  return resolveManifest(declared, env);
}

/**
 * `declared`: an operator submitted the document, so its Target connections
 * and reach override the rows. `booted`: a restart writes it back and existing
 * Target rows keep operator edits. Both create missing Targets and set rank.
 */
export type ManifestWrite = 'declared' | 'booted';

/**
 * Dotted paths where two documents disagree, never values, so a future secret
 * field cannot leak. Stops at a differing leaf or a key missing on one side.
 */
export function diffManifestPaths(
  a: unknown,
  b: unknown,
  path: readonly string[] = [],
): string[] {
  if (Bun.deepEquals(a, b, true)) return [];

  const left = containerEntries(a);
  const right = containerEntries(b);
  if (left === null || right === null) {
    return [path.length === 0 ? '(root)' : path.join('.')];
  }

  const leftByKey = new Map(left);
  const rightByKey = new Map(right);
  const diffs: string[] = [];
  for (const key of new Set([...leftByKey.keys(), ...rightByKey.keys()])) {
    diffs.push(
      ...diffManifestPaths(leftByKey.get(key), rightByKey.get(key), [
        ...path,
        key,
      ]),
    );
  }
  return diffs;
}

/**
 * Paths the next `declared` write would change on this Target's connection;
 * `[]` when the manifest declares none, since the row's connection then stands.
 */
export function targetConnectionDivergence(
  seed: TargetSeed | undefined,
  connection: TargetConnection | null,
): readonly string[] {
  if (seed === undefined) return [];
  const declared = connectionFromSeed(seed);
  if (declared === null) return [];
  return diffManifestPaths(declared, connection, ['connection']);
}

function containerEntries(value: unknown): [string, unknown][] | null {
  if (Array.isArray(value)) {
    return value.map(
      (item, index) => [String(index), item] as [string, unknown],
    );
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>);
  }
  return null;
}

/** The document, its vessels and its Targets are written in one transaction. */
export async function writeStoredManifest(
  db: Database,
  manifest: AuthoredManifest,
  /** Defaults to the stricter `declared`; only the boot path passes `booted`. */
  write: ManifestWrite = 'declared',
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.insert(installation).values({ manifest }).onConflictDoUpdate({
      target: installation.id,
      set: { manifest },
    });
    await reconcileManifestTargets(tx, manifest, write);
  });
}

/** Read-only and outside a transaction, cheap enough to call per command. */
export async function currentStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest | null> {
  const stored = await readStoredManifest(db);
  return stored === null ? null : resolveManifest(stored, env);
}

/**
 * On a `declared` write, a changed connection resets the Target to unhealthy,
 * awaiting inspection. A disconnected row stays disconnected.
 */
async function reconcileManifestTargets(
  db: Pick<Database, 'insert' | 'query'>,
  manifest: AuthoredManifest,
  write: ManifestWrite,
): Promise<void> {
  const reconciledVessels = await reconcileManifestVessels(db, manifest, write);

  for (const [rank, target] of manifest.targets.entries()) {
    const { adapter } = target;
    // The schema refuses a Target whose vessel is not declared.
    const vessel = reconciledVessels.get(target.vessel)!;
    const declaredConnection = connectionFromSeed(target);
    const existing = await db.query.targets.findFirst({
      where: (targets, { and, eq }) =>
        and(eq(targets.vesselId, vessel.id), eq(targets.adapter, adapter)),
    });

    const awaitingInspection = unreachablePrerequisites(
      'Declared Target connection is awaiting inspection',
      adapter,
    );
    const connectionAsserted =
      write === 'declared' &&
      declaredConnection !== null &&
      !Bun.deepEquals(existing?.connection, declaredConnection, true);
    // A moved vessel reassesses without rewriting the connection: on a boot
    // the stored copy can be null and would wipe the connect screen's.
    const reassess = vessel.moved || connectionAsserted;

    await db
      .insert(targets)
      .values({
        adapter,
        vesselId: vessel.id,
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
        target: [targets.vesselId, targets.adapter],
        set: {
          rank,
          // Reach can be set on the row from the connect screen. Kept apart
          // from `connectionAsserted` so a declaration can correct reach alone.
          ...(write === 'declared' ? assertedBySeed(target) : {}),
          ...(connectionAsserted
            ? {
                ...(existing?.status === 'disconnected'
                  ? {}
                  : { status: 'connected' as const }),
                connection: declaredConnection,
              }
            : {}),
          ...(reassess
            ? {
                health: 'unhealthy' as const,
                // The reason names whichever half moved.
                prerequisites: connectionAsserted
                  ? awaitingInspection
                  : unreachablePrerequisites(
                      'The boundary this Target is on moved and is awaiting inspection',
                      adapter,
                    ),
                discovery: null,
                inspectedAt: null,
                updatedAt: sql`now()`,
              }
            : {}),
        },
      });
  }
}

/** Omits an absent reach, so an update keeps what an operator set in the UI. */
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
  return { adapter: target.adapter, ...target.connection } as TargetConnection;
}

/** Keyed by name. `null` is an unstated fact in a nullable column. */
function vesselRowsOf(manifest: AuthoredManifest): Map<
  string,
  {
    kind: VesselKind;
    location: VesselLocation | null;
    servedHosts: string[] | null;
    reachableRegistries: string[] | null;
  }
> {
  return new Map(
    manifest.vessels.map((vessel) => [
      vessel.name,
      {
        kind: vessel.kind,
        // VesselLocation is discriminated on `kind`, which the document states
        // once on the vessel.
        location:
          vessel.location === undefined
            ? null
            : ({ kind: vessel.kind, ...vessel.location } as VesselLocation),
        servedHosts:
          vessel.servedHosts === undefined ? null : [...vessel.servedHosts],
        reachableRegistries:
          vessel.reachableRegistries === undefined
            ? null
            : [...vessel.reachableRegistries],
      },
    ]),
  );
}

interface ReconciledVessel {
  readonly id: string;
  /** The location changed, so every Target on the vessel is reassessed. */
  readonly moved: boolean;
}

/**
 * The control-plane and home vessels are reconciled from the document on every
 * write, boot included. Other vessels keep operator edits on a boot.
 */
async function reconcileManifestVessels(
  db: Pick<Database, 'insert' | 'query'>,
  manifest: AuthoredManifest,
  write: ManifestWrite,
): Promise<Map<string, ReconciledVessel>> {
  const reconciled = new Map<string, ReconciledVessel>();
  for (const [name, vessel] of vesselRowsOf(manifest)) {
    const governed = isDeclaredInstallationVessel(manifest, name);
    const asserted = write === 'declared' || governed;
    const existing = await db.query.vessels.findFirst({
      where: (vessels, { eq }) => eq(vessels.name, name),
    });
    const moved =
      asserted &&
      vessel.location !== null &&
      !Bun.deepEquals(existing?.location, vessel.location, true);
    const [row] = await db
      .insert(vessels)
      .values({ name, ...vessel })
      .onConflictDoUpdate({
        target: vessels.name,
        set: asserted
          ? {
              kind: vessel.kind,
              // Stated facts only: an address often comes later from the
              // connect screen, and an unstated one must not wipe it.
              ...(vessel.location === null
                ? {}
                : { location: vessel.location }),
              ...(vessel.servedHosts === null
                ? {}
                : { servedHosts: vessel.servedHosts }),
              ...(vessel.reachableRegistries === null
                ? {}
                : { reachableRegistries: vessel.reachableRegistries }),
            }
          : // The row wins; rewriting the matched `name` makes this a no-op
            // update that still returns the id.
            { name },
      })
      .returning({ id: vessels.id });
    reconciled.set(name, { id: row!.id, moved });
  }
  return reconciled;
}

/**
 * Before environment resolution. An edit that writes the document back starts
 * here: {@link currentStoredManifest} would bake this pod's environment in.
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
