/**
 * Durable storage for the declared installation manifest.
 *
 * Parsing and validation stay in `manifest.ts`; this module owns the singleton
 * row and reconciles a deployment declaration — including ordered Target
 * identities — into durable state.
 */
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { installation, targets, vessels } from '../db/schema.ts';
import { unreachablePrerequisites } from '../domain/capabilities.ts';
import type { TargetConnection } from '../domain/target.ts';
import {
  claimsDisagree,
  unionOfClaims,
  type VesselKind,
  type VesselLocation,
  vesselKindFor,
} from '../domain/vessel.ts';
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
 *
 * **A stored row this build cannot parse is a row this build has no seed in**,
 * so the declaration takes over rather than the process crash-looping. A
 * manifest key can be renamed — `dns.zones` replaced `dns.apexZone` — and the
 * row written by the previous image does not rewrite itself; strictness there
 * took down an installation whose mounted declaration said, correctly, exactly
 * what it should have been. The cost is stated in the warning: whatever an
 * operator configured through the UI that the declaration does not carry is
 * lost. With no declaration to fall back on there is nothing honest to boot as,
 * and the error stands.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  let stored: AuthoredManifest | null = null;
  let unreadable: ManifestError | null = null;
  try {
    stored = await readStoredManifest(db);
  } catch (cause) {
    if (!(cause instanceof ManifestError)) throw cause;
    unreadable = cause;
  }
  const declaration = await declaredManifest(stored !== null, env);
  if (unreadable !== null) {
    if (declaration === null) throw unreadable;
    console.warn(
      `installation manifest: the stored manifest is not valid for this build, so this installation is being re-seeded from the mounted declaration — anything configured through the UI that the declaration does not carry is lost: ${unreadable.message}`,
    );
  } else if (stored !== null && declaration !== null) {
    // The generic half of this warning has existed since the rule did — "a
    // declaration is mounted and ignored" — and it is not enough. Proven live:
    // a rollout moved a Target's gateway in the declaration; the stored row
    // never moved because the row wins by design; and this line gave nobody a
    // reason to go look, right up until the listener that rollout deleted took
    // the Target's gateway with it. §6: "drift is detected and surfaced, never
    // silently corrected" — naming the paths is that rule applied to the
    // manifest itself, not just to what it deploys.
    const divergentPaths = diffManifestPaths(declaration, stored);
    console.warn(
      divergentPaths.length === 0
        ? 'installation manifest: a declaration is mounted but this installation is already seeded, so the stored manifest is being used and the declaration is ignored — discard the row to re-seed from it'
        : `installation manifest: a declaration is mounted but this installation is already seeded, so the stored manifest is being used and the declaration is ignored — discard the row to re-seed from it. It now disagrees with the stored row at: ${divergentPaths.join(', ')}`,
    );
  }
  const declared = stored ?? declaration ?? DEFAULT_PLACEHOLDER_MANIFEST;
  // `booted` exactly when the document being written is the one the
  // installation already had — see {@link ManifestWrite}. A stored row this
  // build could not parse leaves `stored` null, which is right: that boot is
  // re-seeding from the declaration, and re-seeding is a declaration.
  await writeStoredManifest(
    db,
    declared,
    stored === null ? 'declared' : 'booted',
  );
  return resolveManifest(declared, env);
}

/**
 * What a write of the stored manifest **is**, which is what decides whether a
 * declared Target connection lands on the row.
 *
 * `declared` is a manifest *becoming* this installation's: the seed path and
 * `configureInstallation`, which this module already treats as one act. There a
 * declared connection is desired state — an operator submitted this document —
 * so it is asserted over the row and resets that Target's assessment.
 *
 * `booted` is {@link loadStoredManifest} writing back the document the
 * installation already had. Nothing became anything, so nothing was declared,
 * and re-asserting the manifest's copy of a connection there is this module's
 * own rule broken one noun down: "the stored row wins whenever one exists,
 * because configuration is the UI's to drive and a rollout must not revert what
 * an operator just configured" is the rule a declaration loses to, and a Target
 * an operator corrected through `connectTarget` is that same operator and that
 * same rollout. It ran on every process start, so a connect-screen edit to a
 * manifest-declared Target survived exactly until the next pod restarted, with
 * the screen that accepted it then showing the old values and no reason why.
 *
 * The row therefore wins, and the manifest entry it now disagrees with is
 * reported by {@link targetConnectionDivergence} rather than silently applied —
 * the same answer 51 gave the same tension one level up: keep the precedence,
 * report the divergence.
 *
 * A boot still materializes and ranks. A Target the document names and the
 * table lacks is created, and `rank` is repaired from manifest order; both are
 * facts the document is the only source of, and neither is something an
 * operator can have edited on the row.
 */
export type ManifestWrite = 'declared' | 'booted';

/**
 * Every dotted path where two manifest documents disagree.
 *
 * **Paths only, never a value — deliberately, not just today.** §13 keeps
 * every `TargetConnection` variant credential-free by construction, so
 * nothing in this schema is secret right now. This walk does not lean on
 * that: it is generic over whatever the schema is next asked to carry, and a
 * diff utility that prints what it finds is exactly the code a later
 * secret-bearing field walks straight through unnoticed. Naming where two
 * documents disagree costs nothing extra over naming what they disagree
 * about; only one of the two stays safe if that promise ever slips.
 *
 * Recurses through plain objects and arrays and stops at the first point two
 * branches stop being the same *shape* — a leaf value differs, or a key exists
 * on one side and not the other — reporting the path to that node rather than
 * descending further: there is nothing under an absent key to compare, and a
 * Target that moved from index 2 to index 0 should read as `targets.0`, not
 * as a page of noise about every field underneath it.
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
 * Every dotted path where one Target's row disagrees with what the manifest
 * declares for it.
 *
 * {@link diffManifestPaths} with one argument each side of the boundary 52 is
 * about: the row is what every deploy renders from, the manifest entry is what
 * a `declared` write resets it to, and until now nothing said which was which.
 * Boot no longer overwrites the row, but `configureInstallation` still asserts
 * the whole document — so an operator who corrected a Target through the
 * connect screen has to be able to see that Settings will take it back, on the
 * Target, rather than discover it by pressing Save.
 *
 * Paths, never values, for exactly the reason {@link diffManifestPaths} gives.
 * Rooted at `connection.` so a path reads as the key it is under in the
 * document the operator would go and edit, which is the same spelling the
 * startup warning uses below `targets.N.`.
 *
 * `[]` for a seed that declares no connection: §13 lets the manifest seed an
 * identity and leave the connection to the product, so that Target's connection
 * is the row's outright and there is nothing for it to disagree with. Same for
 * a Target the manifest does not name at all — nothing will ever assert over it.
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

/** `[key, value]` pairs for a plain object or an array; `null` for anything else. */
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
  /**
   * Defaults to `declared`, because every caller but the boot path is an
   * operator submitting a document — and a new one that forgot to say so
   * should get the stricter behaviour rather than the quieter one.
   */
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
 * A declared connection is desired state **on a `declared` write**: it creates a
 * connected row and resets changed connection facts to an unhealthy,
 * awaiting-inspection checklist. On a `booted` write it does not touch an
 * existing row at all, because nothing was declared — see {@link ManifestWrite}
 * for why that distinction is the whole of 52. A disconnected row stays
 * disconnected until reconciler startup can inspect and safely re-adopt its
 * Deploys. Keeping this work in the manifest transaction means an incompatible
 * target cannot poison the durable declaration.
 */
async function reconcileManifestTargets(
  db: Pick<Database, 'insert' | 'query'>,
  manifest: AuthoredManifest,
  write: ManifestWrite,
): Promise<void> {
  const reconciledVessels = await reconcileManifestVessels(db, manifest, write);

  for (const [rank, target] of manifest.targets.entries()) {
    const { name, adapter } = target;
    const vessel = reconciledVessels.get(vesselNameOfSeed(target))!;
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
    // Either half moving invalidates the assessment: the surface's own facts,
    // or the boundary they are facts about.
    const hasConnectionChange =
      vessel.moved ||
      (write === 'declared' &&
        declaredConnection !== null &&
        !Bun.deepEquals(existing?.connection, declaredConnection, true));

    await db
      .insert(targets)
      .values({
        name,
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
  // The boundary's half is stripped out here and lands on the vessel instead.
  // The seed format still states it per surface — see `vesselNameOfSeed` for
  // why that is deliberate, and #61 for its removal.
  switch (target.adapter) {
    case 'kubernetes': {
      const {
        apiServer: _apiServer,
        servedHosts: _servedHosts,
        reachableRegistries: _reachableRegistries,
        ...surface
      } = target.connection;
      return { adapter: 'kubernetes', ...surface };
    }
    case 'cloudrun': {
      const {
        project: _project,
        servedHosts: _servedHosts,
        reachableRegistries: _reachableRegistries,
        ...surface
      } = target.connection;
      return { adapter: 'cloudrun', ...surface };
    }
    case 'static': {
      const {
        project: _project,
        servedHosts: _servedHosts,
        ...surface
      } = target.connection;
      return { adapter: 'static', ...surface };
    }
  }
}

/**
 * Which vessel a seed is a surface of.
 *
 * **The one place left that recovers a boundary from a name**, and it is here
 * rather than in the domain because the *manifest format* still states a
 * boundary per surface: two cloud seeds say they share a project by being
 * called `<name>-cloudrun` and `<name>-static`, which `manifest.schema.ts`
 * enforces. Everything downstream reads `vesselId`.
 *
 * Giving the manifest a `vessels` array — and deleting this — is #61. It was
 * kept out of the change that introduced the Vessel row because a manifest
 * schema change has a failure mode where the stored document fails validation
 * and the installation is silently re-seeded from its declaration, which is
 * worth landing on its own.
 */
function vesselNameOfSeed(target: TargetSeed): string {
  if (target.adapter === 'kubernetes') return target.name;
  const suffix = `-${target.adapter}`;
  return target.name.endsWith(suffix)
    ? target.name.slice(0, -suffix.length)
    : target.name;
}

/** The vessels a manifest's seeds describe between them. */
function vesselsFromSeeds(manifest: AuthoredManifest): Map<
  string,
  {
    kind: VesselKind;
    location: VesselLocation | null;
    servedHosts: string[] | null;
    reachableRegistries: string[] | null;
  }
> {
  const byName = new Map<
    string,
    {
      kind: VesselKind;
      location: VesselLocation | null;
      servedHosts: string[] | null;
      reachableRegistries: string[] | null;
      served: (readonly string[] | undefined)[];
      registries: (readonly string[] | undefined)[];
    }
  >();

  for (const target of manifest.targets) {
    const name = vesselNameOfSeed(target);
    const kind = vesselKindFor(target.adapter);
    const entry = byName.get(name) ?? {
      kind,
      location: null,
      servedHosts: null,
      reachableRegistries: null,
      served: [],
      registries: [],
    };

    if (target.connection !== undefined) {
      // Either surface of a project states the same project id; the first to
      // arrive settles it, and the schema's pairing rule is what makes them
      // agree.
      if (target.adapter === 'kubernetes') {
        entry.location ??= {
          kind: 'cluster',
          apiServer: target.connection.apiServer,
        };
        entry.registries.push(target.connection.reachableRegistries);
      } else {
        entry.location ??= {
          kind: 'gcp-project',
          project: target.connection.project,
        };
        if (target.adapter === 'cloudrun') {
          entry.registries.push(target.connection.reachableRegistries);
        }
      }
      entry.served.push(target.connection.servedHosts);
    }
    byName.set(name, entry);
  }

  const vesselsByName = new Map<
    string,
    {
      kind: VesselKind;
      location: VesselLocation | null;
      servedHosts: string[] | null;
      reachableRegistries: string[] | null;
    }
  >();
  for (const [name, entry] of byName) {
    // The union, not a winner: two surfaces of one boundary *can* state
    // different reach today, and silently taking one would be the bug the
    // Vessel row exists to prevent.
    const servedHosts = entry.served.some((claim) => claim !== undefined)
      ? unionOfClaims(entry.served)
      : null;
    const reachableRegistries = entry.registries.some(
      (claim) => claim !== undefined,
    )
      ? unionOfClaims(entry.registries)
      : null;
    if (claimsDisagree(entry.served) || claimsDisagree(entry.registries)) {
      console.warn(
        `installation manifest: the surfaces of vessel ${name} state different reach; ` +
          'the union is stored, and stating it once per vessel is #61',
      );
    }
    vesselsByName.set(name, {
      kind: entry.kind,
      location: entry.location,
      servedHosts,
      reachableRegistries,
    });
  }
  return vesselsByName;
}

/** One reconciled vessel: its id, and whether this pass moved it. */
interface ReconciledVessel {
  readonly id: string;
  /**
   * Whether the boundary changed in a way its surfaces have to be reassessed
   * for.
   *
   * A Target's checklist is a set of claims about a place — that the namespace
   * exists, that the federated identity may act there. Move the place and every
   * one of those claims is about somewhere else, so the surfaces are reassessed
   * exactly as they are when their own connection changes. Without this a
   * re-pointed `apiServer` would leave every Target on it reading `healthy`
   * against a cluster nobody has looked at.
   */
  readonly moved: boolean;
}

/** Create or update the vessels a manifest describes, and return their ids. */
async function reconcileManifestVessels(
  db: Pick<Database, 'insert' | 'query'>,
  manifest: AuthoredManifest,
  write: ManifestWrite,
): Promise<Map<string, ReconciledVessel>> {
  const reconciled = new Map<string, ReconciledVessel>();
  for (const [name, vessel] of vesselsFromSeeds(manifest)) {
    const existing = await db.query.vessels.findFirst({
      where: (vessels, { eq }) => eq(vessels.name, name),
    });
    const moved =
      write === 'declared' &&
      vessel.location !== null &&
      !Bun.deepEquals(existing?.location, vessel.location, true);
    const [row] = await db
      .insert(vessels)
      .values({ name, ...vessel })
      .onConflictDoUpdate({
        target: vessels.name,
        set: {
          kind: vessel.kind,
          location: vessel.location,
          servedHosts: vessel.servedHosts,
          reachableRegistries: vessel.reachableRegistries,
        },
      })
      .returning({ id: vessels.id });
    reconciled.set(name, { id: row!.id, moved });
  }
  return reconciled;
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
