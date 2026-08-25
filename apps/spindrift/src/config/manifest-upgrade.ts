/**
 * Bringing a manifest document written under an older schema up to this one.
 *
 * **This is what stands between a schema change and an installation that
 * cannot boot.** The stored row is the only document this installation has —
 * `loadStoredManifest` resolves `stored ?? placeholder` — so a row this build
 * cannot parse is a boot with nothing left to read. That refusal is right for a
 * genuinely corrupt document and wrong for a merely old one, and validation
 * alone cannot tell them apart. This module is what makes the difference: run
 * before validation, an old document becomes a current one and never reaches
 * the refusal, and a document that still fails afterwards is a real fault.
 *
 * It runs inside {@link validateManifest}, which is the one gate every document
 * passes through — the stored row, the placeholder seed, and the document
 * `configureInstallation` accepts, typed into the settings form or pasted back
 * from an export. A restored document matters as much as the row here: an
 * export and the image that later reads it are taken at different times, so a
 * restore routinely carries a document written for the other schema, whichever
 * direction the skew runs in.
 *
 * Every upgrade here is a **pure function of the document**, never of the
 * database or the environment. That is what lets `loadStoredManifest` persist
 * the result by writing back the document it just read, inside the transaction
 * it already opens, rather than needing a migration step of its own.
 *
 * `test/config/manifest-upgrade.test.ts` holds a fixture per historical shape
 * and boots each one; adding a shape to that corpus is how a future schema
 * change proves it did not make the refusal reachable.
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
  return dropControlPlane(
    dropDeviceFlowIdentity(
      listDnsZones(
        movePinnedBuildWorkflowToMain(
          scrubPlaceholderBuildWorkflow(
            nameInstallationVessels(
              dropTargetNames(addDeclaredVessels(document)),
            ),
          ),
        ),
      ),
    ),
  );
}

/**
 * Drop the control plane's own hostname, which is no longer authored.
 *
 * `controlPlane.hostname` is the passkey relying party and was a second copy of
 * the `hostname` the chart already renders the Gateway and the HTTPRoute from.
 * It is now resolved from the deployment (`manifest.ts:resolveManifest`), so
 * the schema is `.strict()` against it and every row written before this step
 * carries one.
 *
 * A drop rather than a read: the value in the row is the same value the
 * deployment supplies — the chart refused to render a release where the two
 * disagreed — so there is nothing here worth carrying forward, and carrying it
 * forward would be the second copy again one layer down.
 *
 * The whole key, not just the hostname inside it. `controlPlane` held exactly
 * one key, so a document that kept an empty object would fail the same
 * `.strict()` parse for a different reason.
 */
function dropControlPlane(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null || !('controlPlane' in manifest)) return document;
  const { controlPlane: _served, ...rest } = manifest;
  return rest;
}

/**
 * Turn the zone-named-per-reach object into the list of zones that replaced it.
 *
 * `dns.zones` was `{private, public}`: two names, one per reach, which made two
 * the most zones an installation could have. It is now a list, and each entry
 * states the reaches it serves — so the same two facts are still sayable and a
 * third zone is as well.
 *
 * **The two shapes the old object had become different lists, because they meant
 * different things.** Both names equal was an installation pointing one zone at
 * both reaches, and that is one entry serving both — which is what keeps §9's
 * "flipping a Component's reach is a record re-point" true across this upgrade.
 * Two different names was a split-horizon installation, and that is two entries
 * of one reach each. Collapsing the first into two entries would leave a
 * `private` Component that flips to `public` minting in the entry that happens
 * to be first, which is the same zone by luck rather than by the document
 * saying so.
 *
 * Private leads in the split case for the same reason `reach: private` was the
 * old column default: it is the narrower boundary, and the head of this list is
 * what an App that pins nothing gets.
 *
 * A current document holds an array here, and `asDocument` returns null for one,
 * so this is a no-op on everything written since.
 */
function listDnsZones(document: unknown): unknown {
  const manifest = asDocument(document);
  const dns = asDocument(manifest?.dns);
  const zones = asDocument(dns?.zones);
  if (manifest === null || dns === null || zones === null) return document;

  const privateZone = firstString(zones.private);
  const publicZone = firstString(zones.public);
  if (privateZone === null || publicZone === null) return document;

  return {
    ...manifest,
    dns: {
      ...dns,
      zones:
        privateZone === publicZone
          ? [{ name: privateZone, reaches: ['private', 'public'] }]
          : [
              { name: privateZone, reaches: ['private'] },
              { name: publicZone, reaches: ['public'] },
            ],
    },
  };
}

/**
 * Retire the Device Flow keys from the `github` block.
 *
 * `clientId` named the App identity when Device Flow was the ceremony; the
 * identity now lives sealed in the `github_app` row, written by the
 * manifest-flow conversion, so the key describes nothing and is dropped.
 * `oauthBaseUrl` named the web origin the OAuth endpoints lived on — the
 * endpoints have no caller left, but the origin itself is still the web host
 * clone URLs and install links are composed from, so it becomes `webBaseUrl`
 * unless the document already states one.
 *
 * This step is what makes the skew between a stored row and the image reading
 * it advisory rather than load-bearing: a row still carrying the legacy keys
 * cannot fail a parse, and neither can a document that never had them.
 */
function dropDeviceFlowIdentity(document: unknown): unknown {
  const manifest = asDocument(document);
  const github = asDocument(manifest?.github);
  if (
    manifest === null ||
    github === null ||
    !('clientId' in github || 'oauthBaseUrl' in github)
  ) {
    return document;
  }
  const { clientId: _retired, oauthBaseUrl, ...rest } = github;
  return {
    ...manifest,
    github: {
      ...rest,
      ...(typeof rest.webBaseUrl === 'string' || oauthBaseUrl === undefined
        ? {}
        : { webBaseUrl: oauthBaseUrl }),
    },
  };
}

/**
 * The one commit a seed declaration ever pinned `buildWorkflow` at, and this
 * project's own vocabulary rather than anyone's identity — which is why the
 * step below may match on it where the extraction contract forbids naming the
 * repository the workflow lives in. Exactly this sha, never a pattern: any
 * other ref is an operator's pin, and it is theirs whatever it names.
 */
const SEED_PINNED_WORKFLOW_REF = '@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6';

/**
 * The sha a seed declaration pinned, moved to `@main`.
 *
 * The reusable workflow ref may move — see the `buildWorkflow` docblock in
 * `manifest.schema.ts`: a branch keeps every written caller current, and the
 * platform repository's merge gate is the version gate. An installation seeded
 * before that edit holds the pin where nothing outside the product can reach
 * it — the row is the only document there is — and every caller it writes into
 * a connected repository copies a workflow frozen at that commit. The repository half of the value is kept, not restated:
 * which repository publishes the workflow is the installation's fact, and the
 * document already carries it.
 *
 * **Must run after {@link scrubPlaceholderBuildWorkflow}**: the placeholder it
 * nulls ends in this same sha, and moved instead of nulled it would be a live
 * `@main` pointer at a repository this project does not own. The corpus's
 * placeholder snapshot holds that ordering in place.
 */
function movePinnedBuildWorkflowToMain(document: unknown): unknown {
  const manifest = asDocument(document);
  const github = asDocument(manifest?.github);
  const workflow = github?.buildWorkflow;
  if (
    manifest === null ||
    github === null ||
    typeof workflow !== 'string' ||
    !workflow.endsWith(SEED_PINNED_WORKFLOW_REF)
  ) {
    return document;
  }
  return {
    ...manifest,
    github: {
      ...github,
      buildWorkflow: `${workflow.slice(0, -SEED_PINNED_WORKFLOW_REF.length)}@main`,
    },
  };
}

/**
 * The one placeholder workflow ref a seed document ever carried, nulled.
 *
 * The chart's seed document stated this exact value, and the stored row keeps
 * whatever seeded it — so an installation seeded from that document holds the
 * value where nothing outside the product can reach it. It
 * is not inert the way `spindrift.example.com` is: `connectRepository` writes
 * it into a caller workflow inside connected repositories, and it names a
 * repository this project does not own. Null is the schema's own word for "no
 * workflow published", and connect refuses on it until an operator states a
 * real one.
 *
 * Exact-match on the one historical string, never a pattern: any other value
 * is an operator's pin, and it is theirs whatever it names.
 */
function scrubPlaceholderBuildWorkflow(document: unknown): unknown {
  const manifest = asDocument(document);
  const github = asDocument(manifest?.github);
  if (
    manifest === null ||
    github === null ||
    github.buildWorkflow !==
      'spindrift/infra/.github/workflows/spindrift-build.yml@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6'
  ) {
    return document;
  }
  return { ...manifest, github: { ...github, buildWorkflow: null } };
}

/**
 * Turn the four loose strings that described this installation's own two
 * boundaries into two pointers and one vessel's properties.
 *
 * `installation` was an opaque label; it is now the block that names the vessel
 * the control plane runs on and the vessel holding the shared services.
 * `cloud.homeVesselProject`, `cloud.artifactsProject`, `sources.defaultBucket`
 * and `secretStore.container` were four keys that all described the second one
 * without anything saying so, and they move onto it.
 *
 * **Both pointers are recovered rather than guessed, and each from the one
 * thing the old document actually stated.**
 *
 * The home vessel is the boundary whose `location.project` is the project
 * `cloud.homeVesselProject` named — the two were the same value on every
 * installation that has one, which is the whole reason the collapse is
 * expressible. Where they were not, the first `gcp-project` vessel takes the
 * role: the old key could name a project that was never a declared boundary,
 * and minting a vessel for it here would recover a boundary from a string,
 * which is precisely what the `vessels` key exists to stop.
 *
 * The control plane is the vessel of the **first** Target. Rank is array
 * position (`reconcileManifestTargets`), the control plane's own cluster is its
 * in-cluster destination, and rank 0 is where every document written so far put
 * it. It is a recovery of one fact from one document shape, run once — after
 * this the document states it and nothing derives it again.
 *
 * Runs last, because it reads `vessels` and `targets[].vessel`, which the two
 * steps above are what put there.
 */
function nameInstallationVessels(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null) return document;
  // Already current: `installation` is the block rather than the label.
  if (asDocument(manifest.installation) !== null) return document;
  if (typeof manifest.installation !== 'string') return document;

  const vessels = Array.isArray(manifest.vessels) ? manifest.vessels : null;
  const targets = Array.isArray(manifest.targets) ? manifest.targets : null;
  const cloud = asDocument(manifest.cloud);
  const sources = asDocument(manifest.sources);
  const secretStore = asDocument(manifest.secretStore);
  if (vessels === null || targets === null) return document;

  const declared = vessels.flatMap((seed) => {
    const vessel = asDocument(seed);
    return vessel === null || typeof vessel.name !== 'string' ? [] : [vessel];
  });
  if (declared.length !== vessels.length) return document;

  const home = homeVesselIn(declared, cloud?.homeVesselProject);
  const controlPlane = asDocument(targets[0])?.vessel;
  if (home === null || typeof controlPlane !== 'string') return document;

  const buckets = sources?.buckets;
  const sourceBucket =
    firstString(sources?.defaultBucket) ??
    (Array.isArray(buckets) ? firstString(buckets[0]) : null);
  const artifactsProject = firstString(cloud?.artifactsProject);
  const secretStoreContainer = firstString(secretStore?.container);
  if (
    sourceBucket === null ||
    artifactsProject === null ||
    secretStoreContainer === null
  ) {
    return document;
  }

  const { defaultBucket: _moved, ...remainingSources } = sources ?? {};
  const { container: _held, ...remainingStore } = secretStore ?? {};
  const { cloud: _derivedNow, ...rest } = manifest;
  return {
    ...rest,
    installation: {
      name: manifest.installation,
      controlPlaneVessel: controlPlane,
      homeVessel: home.name,
    },
    sources: remainingSources,
    secretStore: remainingStore,
    // Rebuilt in place, in order: nothing reads a vessel's position, but two
    // documents that differ only by order would diff as changed.
    vessels: declared.map((vessel) =>
      vessel === home
        ? {
            ...vessel,
            shared: { sourceBucket, artifactsProject, secretStoreContainer },
          }
        : vessel,
    ),
  };
}

/**
 * Which declared boundary `cloud.homeVesselProject` was describing.
 *
 * The project match first, because that is the document stating it. The first
 * cloud vessel behind it, because the old key was free to name a project no
 * vessel declared and this upgrade may not invent one.
 */
function homeVesselIn(
  declared: readonly Document[],
  homeVesselProject: unknown,
): (Document & { name: string }) | null {
  const named =
    typeof homeVesselProject === 'string'
      ? declared.find(
          (vessel) =>
            asDocument(vessel.location)?.project === homeVesselProject,
        )
      : undefined;
  const home =
    named ?? declared.find((vessel) => vessel.kind === 'gcp-project') ?? null;
  return home === null ? null : (home as Document & { name: string });
}

/** A stated string, or `null` for anything that is not one. */
function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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
 * **The kind comes from the document wherever the document states it.** What
 * kind of boundary this is means only what shape its location has, and the old
 * connection stated that shape directly: an `apiServer` is a cluster and a
 * `project` is a cloud project. Reading it back off the surface's adapter would
 * assume each surface belongs to exactly one kind — the assumption a project
 * that runs a cluster breaks — and would do it inside the one function nothing
 * else can check.
 *
 * A Target seeded and not yet connected stated no address at all, and that is a
 * shape the old schema allowed and the current one still does: `location` is
 * optional on a vessel seed for the same reason the column is nullable. Such a
 * document says nothing to read a shape off, so the kind falls back to the one
 * `0022_vessels.sql` wrote on the same evidence — `cluster` for a kubernetes
 * surface, `gcp-project` for a cloud one. That is not a guess about the
 * boundary: it is what this installation's vessel row already says, and
 * disagreeing with it would mint a second vessel beside the migrated one.
 * Declaring nothing would be worse than either — `vessels` is required, so the
 * document would fail validation and the boot would have nothing left to read,
 * which is the loss this module stands between.
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
      /** The kind `0022_vessels.sql` gave this boundary. A fallback only. */
      backfilled: VesselKind;
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

    // A cluster's Target keeps its whole name. The suffix existed to tell two
    // surfaces of one project apart, so a cluster never carried one — which
    // makes `<name>-kubernetes` a legal name that stripping would rename the
    // boundary out of. `0022_vessels.sql` derives both names exactly this way,
    // and agreeing with it is what makes this an upgrade of the rows an
    // installation has rather than a second set beside them.
    const vesselName =
      adapter === 'kubernetes' ? name : stripSuffix(name, `-${adapter}`);
    const vessel = vessels.get(vesselName) ?? {
      name: vesselName,
      backfilled: adapter === 'kubernetes' ? 'cluster' : 'gcp-project',
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
  for (const {
    name,
    backfilled,
    kind,
    location,
    served,
    registries,
  } of vessels.values()) {
    declared.push({
      name,
      // What the document stated; where it stated nothing, the answer the
      // backfill already wrote for this row.
      kind: kind ?? backfilled,
      // Omitted rather than present-and-undefined when no surface said where
      // the boundary is: the column is nullable for the same reason, and a key
      // that is there holding nothing is a third state nobody reads.
      ...(location === undefined ? {} : { location }),
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
