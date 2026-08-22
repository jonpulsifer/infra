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
  resolveManifest,
  validateManifest,
} from './manifest.ts';

type Env = Record<string, string | undefined>;

/**
 * Load the durable singleton, seeding it with the placeholder when it is empty.
 *
 * **The row is the whole of what this installation is.** Nothing is mounted and
 * nothing is reconciled from anywhere: what an operator configured is what the
 * next process reads, and an installation with no row yet is seeded with the
 * placeholder so onboarding has a document to edit rather than a null to
 * special-case.
 *
 * What is written is the authored document; what is returned has the
 * deployment's own facts resolved onto it. The row therefore never holds a
 * second copy of something the deployment declares — which is the whole of why
 * the two types are different.
 *
 * **A row this build cannot parse is fatal.** It used to be survivable by
 * re-seeding from the mounted declaration, at the cost of discarding whatever
 * an operator had configured that the declaration did not carry. There is no
 * declaration to re-seed from, so `manifest-upgrade.ts` is what makes a row
 * written under an older schema readable — and a document that reaches here
 * unparseable is one that module has to learn a step for, not one to boot past.
 */
export async function loadStoredManifest(
  db: Database,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const stored = await readStoredManifest(db);
  const declared = stored ?? DEFAULT_PLACEHOLDER_MANIFEST;
  // `booted` exactly when the document being written is the one the
  // installation already had — see {@link ManifestWrite}. A row this build
  // could not parse does not reach here: `readStoredManifest` throws, and with
  // nothing to fall back to there is nothing honest to boot as.
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
    // The declaration asserting its own copy of this connection over the row,
    // which only a `declared` write does — see {@link ManifestWrite}.
    const connectionAsserted =
      write === 'declared' &&
      declaredConnection !== null &&
      !Bun.deepEquals(existing?.connection, declaredConnection, true);
    // Either half moving invalidates the assessment: the surface's own facts,
    // or the boundary they are facts about. Only the first of the two moves the
    // connection, and keeping them apart is what makes a governed vessel safe to
    // reconcile on a boot: there `declaredConnection` is the stored document's
    // own copy — `null` for every Target the manifest seeds without connection
    // facts — so writing it would silently discard the connection an operator
    // supplied through the connect screen, on the strength of a boundary edit
    // that said nothing about it. The row would still read `connected` while
    // `hasTargetConnection` skipped it everywhere.
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
                // The reason the checklist was thrown away, in the words of
                // whichever half moved. A boundary that moved under a Target
                // nobody declared a connection for is not "a declared Target
                // connection awaiting inspection", and reading that on a
                // screen would send an operator looking for a declaration
                // that says nothing about it.
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
              // Stated facts only. Omitted rather than nulled for the reason
              // {@link assertedBySeed} gives about reach: a declaration that
              // says nothing about where a boundary is has not said it is
              // nowhere, and the connect screen is where an address most often
              // comes from — §13 makes `location` optional on a seed precisely
              // so a boundary can be declared and addressed later. Nulling here
              // wiped that address on every boot of a governed vessel. A new
              // row still gets `null`, because there an unstated fact is
              // genuinely unknown rather than known elsewhere.
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
