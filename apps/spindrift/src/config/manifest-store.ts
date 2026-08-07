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
import type { VesselKind, VesselLocation } from '../domain/vessel.ts';
import {
  type AuthoredManifest,
  type InstallationManifest,
  isDeclaredInstallationVessel,
  type TargetSeed,
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
  }
  const declared =
    stored === null
      ? (declaration ?? DEFAULT_PLACEHOLDER_MANIFEST)
      : declaration === null
        ? stored
        : governedByDeclaration(stored, declaration);
  if (unreadable === null && stored !== null && declaration !== null) {
    // The generic half of this warning has existed since the rule did — "a
    // declaration is mounted and ignored" — and it is not enough. Proven live:
    // a rollout moved a Target's gateway in the declaration; the stored row
    // never moved because the row wins by design; and this line gave nobody a
    // reason to go look, right up until the listener that rollout deleted took
    // the Target's gateway with it. §6: "drift is detected and surfaced, never
    // silently corrected" — naming the paths is that rule applied to the
    // manifest itself, not just to what it deploys.
    //
    // Against the document actually being used rather than against the row, so
    // the governed slice does not appear as divergence a boot has already
    // resolved: what this names is what is genuinely ignored.
    const divergentPaths = diffManifestPaths(declaration, declared);
    console.warn(
      divergentPaths.length === 0
        ? 'installation manifest: a declaration is mounted but this installation is already seeded, so the stored manifest is being used and the declaration is ignored — discard the row to re-seed from it'
        : `installation manifest: a declaration is mounted but this installation is already seeded, so the stored manifest is being used and the declaration is ignored — discard the row to re-seed from it. It now disagrees with the stored row at: ${divergentPaths.join(', ')}`,
    );
  }
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
 * The stored document with the two vessels this installation is built on taken
 * from the mounted declaration.
 *
 * **The one slice a declaration governs.** Everywhere else the row wins, because
 * configuration is the UI's to drive and a rollout must not revert what an
 * operator just configured. These two are the exception, and the reason is that
 * the failure they protect against is not a reverted edit but an installation
 * that cannot come back: a control plane pointed at a boundary that is not
 * there, or a home vessel whose bucket, store and signer nobody can reach.
 *
 * Both pointers move with the entries, so a declaration may hand the role to a
 * different boundary in one edit. The old home's `shared` block goes with the
 * role — the schema admits exactly one vessel carrying it — and a governed
 * vessel the row does not have yet is added rather than dropped.
 *
 * **A merge that will not validate is not applied.** A declaration and the image
 * that understands it land in separate merges, so a document this build reads
 * differently is the ordinary shape of a rollout rather than a fault; taking the
 * row whole is the same fallback `declaredManifest` already makes one step
 * earlier, and it keeps a healthy installation running.
 */
function governedByDeclaration(
  stored: AuthoredManifest,
  declaration: AuthoredManifest,
): AuthoredManifest {
  const governed = new Set([
    declaration.installation.controlPlaneVessel,
    declaration.installation.homeVessel,
  ]);
  const declared = new Map(
    declaration.vessels
      .filter((vessel) => governed.has(vessel.name))
      .map((vessel) => [vessel.name, vessel] as const),
  );
  const kept = stored.vessels.map((vessel) => {
    const replacement = declared.get(vessel.name);
    if (replacement !== undefined) return replacement;
    // Only the outgoing home can be carrying this, and it is not the home any
    // more — two vessels declaring the shared services is two answers to one
    // question and the schema refuses it.
    const { shared: _handedOver, ...withoutShared } = vessel;
    return withoutShared;
  });
  const merged = {
    ...stored,
    installation: {
      ...stored.installation,
      controlPlaneVessel: declaration.installation.controlPlaneVessel,
      homeVessel: declaration.installation.homeVessel,
    },
    vessels: [
      ...kept,
      ...[...declared.values()].filter(
        (vessel) =>
          !stored.vessels.some((existing) => existing.name === vessel.name),
      ),
    ],
  };
  try {
    return validateManifest(merged, 'the governed installation vessels');
  } catch (cause) {
    if (!(cause instanceof ManifestError)) throw cause;
    console.warn(
      `installation manifest: the declaration's installation vessels do not compose with the stored document for this build, so the stored one is being used whole: ${cause.message}`,
    );
    return stored;
  }
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
    const { adapter } = target;
    // Non-null because the document-level refinement in `manifest.schema.ts`
    // refuses a Target whose `vessel` names nothing declared, so a validated
    // manifest cannot reach here with a reference that does not resolve.
    const vessel = reconciledVessels.get(target.vessel)!;
    const declaredConnection = connectionFromSeed(target);
    // By the pair that identifies a Target, which is also its unique index.
    // There is no adapter mismatch to check for any more: a seed naming a
    // different adapter is a different Target, not a redefinition of this one.
    const existing = await db.query.targets.findFirst({
      where: (targets, { and, eq }) =>
        and(eq(targets.vesselId, vessel.id), eq(targets.adapter, adapter)),
    });

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
          // §3's asserted half follows the connection, not the rank: a reach is
          // something an operator can have set on the row — the connect screen
          // derives one from the gateway and the tunnel and posts it — so a
          // `booted` write must not re-assert the document's copy over it, for
          // the reason {@link ManifestWrite} records. A `declared` write is an
          // operator submitting this document, so there it is desired state.
          //
          // Outside the `hasConnectionChange` branch deliberately: a
          // declaration can correct a reach without touching the connection,
          // and folded in there that edit would land nothing.
          ...(write === 'declared' ? assertedBySeed(target) : {}),
          ...(hasConnectionChange
            ? {
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
            : {}),
        },
      });
  }
}

/**
 * The asserted columns a seed declares, if it declares any.
 *
 * Omitted rather than nulled when absent, so a declaration that says nothing
 * about reach leaves whatever an operator asserted through the UI standing —
 * the same "a declaration seeds, it does not govern" rule the connection follows.
 * That rule is why this is spread on update only for a `declared` write: see the
 * set clause above and {@link ManifestWrite}.
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

/**
 * The surface half of a seed, which is now the whole of what a seed's
 * connection carries.
 *
 * A straight widening: the schema no longer accepts a boundary fact on a
 * Target's connection, so there is nothing left to strip. It stays a function
 * because the adapter tag lives on the seed and inside `TargetConnection`, and
 * the discriminated union is what carries it across.
 */
function connectionFromSeed(target: TargetSeed): TargetConnection | null {
  if (target.connection === undefined) return null;
  return { adapter: target.adapter, ...target.connection } as TargetConnection;
}

/**
 * The vessel row each declared vessel is, keyed by name.
 *
 * **No derivation.** The document says which boundaries exist and where they
 * are; nothing here recovers one from a Target's name, and nothing reconciles
 * two surfaces' competing claims about one boundary, because the schema no
 * longer lets a surface make one. Documents that were written that way are
 * brought forward once, in `manifest-upgrade.ts`, before they ever reach here.
 *
 * `null` rather than omitted for an unstated fact, because these are column
 * values: the row's `location`, `served_hosts` and `reachable_registries` are
 * nullable exactly so a seeded-but-unconnected boundary is representable.
 */
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
        // The kind is folded back into the location because
        // {@link VesselLocation} is discriminated on its own. The document
        // states it once, on the vessel, so the two cannot disagree.
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

/**
 * Create or update the vessels a manifest describes, and return their ids.
 *
 * **Two names are governed and every other vessel is seeded.** The vessel this
 * control plane runs on and the vessel holding its shared services take the
 * `declared` treatment on every boot: the row is reconciled from the mounted
 * declaration whether or not it already exists, and a moved boundary reassesses
 * its surfaces. Every other vessel keeps the module's own rule — a declaration
 * seeds and does not govern — so a boot leaves alone whatever an operator
 * corrected through the connect screen.
 *
 * This narrows that rule rather than inverting it, and the narrowing is what
 * makes the pointers safe: you should not be able to click your way into an
 * unbootable control plane or a home vessel pointing at nothing, and the two
 * screens that could do it are the ones that now render these read-only.
 *
 * **No prune policy is owed**, which is the other thing scoping it this way
 * buys. A governed set that can shrink has to answer what "no longer declared"
 * means, and Spindrift never removes a workload, so the answer would be forced
 * to orphan anyway. A fixed two-element set never asks the question.
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
              location: vessel.location,
              servedHosts: vessel.servedHosts,
              reachableRegistries: vessel.reachableRegistries,
            }
          : // Nothing became anything on a `booted` write of an ungoverned
            // vessel, so the row wins outright. `name` is what the conflict
            // matched on, so writing it back changes nothing and is what makes
            // this a no-op update rather than a statement that needs a second
            // code path.
            { name },
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
