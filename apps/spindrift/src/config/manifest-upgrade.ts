/**
 * Bringing a manifest document written under an older schema up to this one.
 *
 * **This is what stands between a schema change and a silently re-seeded
 * installation.** The stored row governs — `loadStoredManifest` resolves
 * `stored ?? declaration ?? placeholder` — and a row this build cannot parse is
 * a row this build treats as having no seed at all, so it re-seeds from the
 * mounted declaration and discards everything an operator configured through
 * the UI. That fallback is right for a genuinely corrupt document and wrong for
 * a merely old one, and validation alone cannot tell them apart. This module
 * is what makes the difference: run before validation, an old document becomes
 * a current one and never reaches the fallback, and a document that still fails
 * afterwards is a real fault.
 *
 * It runs inside {@link validateManifest}, which is the one gate every document
 * passes through — the stored row, the mounted declaration, and the document
 * `configureInstallation` accepts. The mounted declaration matters as much as
 * the row here: a declaration and the image that understands it land in
 * separate merges, so for the window between them an installation is reading a
 * document written for the other schema, whichever direction the skew runs in.
 *
 * Every upgrade here is a **pure function of the document**, never of the
 * database or the environment. That is what lets `loadStoredManifest` persist
 * the result by writing back the document it just read, inside the transaction
 * it already opens, rather than needing a migration step of its own.
 *
 * `test/config/manifest-upgrade.test.ts` holds a fixture per historical shape
 * and boots each one; adding a shape to that corpus is how a future schema
 * change proves it did not make the re-seed reachable.
 */
import { unionOfClaims, type VesselKind } from '../domain/vessel.ts';

/** A JSON object, as a document is before anything has validated it. */
type Document = Record<string, unknown>;

function asDocument(value: unknown): Document | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Document)
    : null;
}

/**
 * A manifest document as the running schema expects it.
 *
 * Returns its argument untouched when there is nothing to do, which is the
 * common case: every document written since this shipped is already current,
 * and an unrecognizable one is left exactly as it arrived so validation reports
 * what is wrong with it rather than reporting what this function made of it.
 */
export function upgradeManifestDocument(document: unknown): unknown {
  return dropTargetNames(addDeclaredVessels(document));
}

/**
 * Take the constructed `name` off every Target entry.
 *
 * A Target is `(vessel, adapter)`. Its `name` was those two joined by a hyphen —
 * or the vessel's name alone where the vessel had only one surface, since the
 * suffix existed to tell siblings apart. That made it decorative once the vessel
 * became a key of its own, and made it a rename hazard the moment a vessel could
 * discover a surface it did not have before.
 *
 * **Nothing is derived from it.** The two lines under it were already
 * authoritative, so this discards the field rather than reading it — which is
 * also why this step is safe to run over a document {@link addDeclaredVessels}
 * has just rewritten: that function *put* `vessel` on every entry.
 *
 * Runs second for that reason, and returns its argument untouched when no entry
 * carries the key, which is what keeps this a no-op on a current document.
 */
function dropTargetNames(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null) return document;

  const seeds = Array.isArray(manifest.targets) ? manifest.targets : null;
  if (seeds === null) return document;
  if (!seeds.some((seed) => asDocument(seed) !== null && 'name' in seed)) {
    return document;
  }

  return {
    ...manifest,
    // Rebuilt in place, in order: `reconcileManifestTargets` reads a Target's
    // rank from its position in this array.
    targets: seeds.map((seed) => {
      const target = asDocument(seed);
      if (target === null) return seed;
      const { name: _discarded, ...rest } = target;
      return rest;
    }),
  };
}

/**
 * Give a document that predates `vessels` the array it is missing.
 *
 * A vessel used to be spelled as the shared prefix of `<name>-cloudrun` and
 * `<name>-static`, with its own facts — where it is, what it can reach —
 * restated on each surface's connection. **This function holds the last suffix
 * parse in the codebase**, deliberately: recovering a boundary from a name is
 * exactly what the `vessels` key exists to stop, and the only honest place for
 * that logic is a one-shot upgrade of the documents that were written that way.
 *
 * The derivation is the one the seeding path performed on every boot before
 * this key existed, so an installation upgraded here gets the same vessel rows
 * it already has: the same names, and the same union of what two surfaces of
 * one boundary each claimed about it.
 *
 * **The kind comes from the document, never from the adapter.** What kind of
 * boundary this is means only what shape its location has, and the old
 * connection stated that shape directly: an `apiServer` is a cluster and a
 * `project` is a cloud project. Reading it back off the surface's adapter would
 * assume each surface belongs to exactly one kind — the assumption a project
 * that runs a cluster breaks — and would do it inside the one function nothing
 * else can check.
 */
function addDeclaredVessels(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null || 'vessels' in manifest) return document;

  const seeds = Array.isArray(manifest.targets) ? manifest.targets : null;
  if (seeds === null) return document;

  const vessels = new Map<
    string,
    {
      name: string;
      kind?: VesselKind;
      location?: Document;
      served: (readonly string[] | undefined)[];
      registries: (readonly string[] | undefined)[];
    }
  >();
  const targets: Document[] = [];

  for (const seed of seeds) {
    const target = asDocument(seed);
    const adapter = target?.adapter;
    const name = target?.name;
    if (
      target === null ||
      typeof name !== 'string' ||
      (adapter !== 'kubernetes' &&
        adapter !== 'cloudrun' &&
        adapter !== 'static')
    ) {
      // Not a document this function recognizes. Hand it back whole so
      // validation names what is actually wrong with it.
      return document;
    }

    const vesselName = stripSuffix(name, `-${adapter}`);
    const vessel = vessels.get(vesselName) ?? {
      name: vesselName,
      served: [],
      registries: [],
    };

    const connection = asDocument(target.connection);
    if (connection !== null) {
      // The first surface to state where the boundary is settles it, and with
      // it the kind; under the old schema the pairing rule was what made two
      // surfaces of one project agree about that.
      const {
        apiServer,
        project,
        servedHosts,
        reachableRegistries,
        ...surface
      } = connection;
      const boundary = boundaryOf(apiServer, project);
      if (boundary !== null && vessel.kind === undefined) {
        vessel.kind = boundary.kind;
        vessel.location = boundary.location;
      }
      vessel.served.push(asStrings(servedHosts));
      // `static` never carried this key, so it contributes nothing rather than
      // an empty claim — `undefined` is unstated and `[]` is stated-and-empty.
      if (adapter !== 'static') {
        vessel.registries.push(asStrings(reachableRegistries));
      }
      targets.push({ ...target, vessel: vesselName, connection: surface });
    } else {
      targets.push({ ...target, vessel: vesselName });
    }
    vessels.set(vesselName, vessel);
  }

  const declared: Document[] = [];
  for (const { name, kind, location, served, registries } of vessels.values()) {
    // A boundary no surface stated an address for is one this document never
    // says the shape of. Handed back whole rather than typed by guesswork —
    // validation then reports the document, which is a fault somebody can read,
    // where a guessed kind is a location shape nothing would ever check.
    if (kind === undefined || location === undefined) return document;
    declared.push({
      name,
      kind,
      location,
      // The union rather than a winner, matching the backfill: two surfaces
      // of one boundary *could* state different reach under the old schema,
      // and silently taking one would be the bug the vessel exists to
      // prevent. Omitted entirely when no surface stated it, because absent
      // and `[]` mean different things.
      ...(served.some((claim) => claim !== undefined)
        ? { servedHosts: unionOfClaims(served) }
        : {}),
      ...(registries.some((claim) => claim !== undefined)
        ? { reachableRegistries: unionOfClaims(registries) }
        : {}),
    });
  }

  return {
    ...manifest,
    vessels: declared,
    // Rebuilt in place, in order: `reconcileManifestTargets` reads a Target's
    // rank from its position in this array.
    targets,
  };
}

function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

/**
 * Which boundary an old connection was describing, from what it stated.
 *
 * The kind and the location are one answer rather than two: `kind` is the
 * discriminant of `VesselLocation`, so whichever address the connection carried
 * settles both. `null` means the connection said nothing about where the
 * boundary is, which is not the same as it being a boundary of some default
 * kind.
 */
function boundaryOf(
  apiServer: unknown,
  project: unknown,
): { kind: VesselKind; location: Document } | null {
  if (typeof apiServer === 'string') {
    return { kind: 'cluster', location: { apiServer } };
  }
  if (typeof project === 'string') {
    return { kind: 'gcp-project', location: { project } };
  }
  return null;
}

/** A claim about a boundary, or `undefined` for anything that is not one. */
function asStrings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((it) => typeof it === 'string')
    ? value
    : undefined;
}
