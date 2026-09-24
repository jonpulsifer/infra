/**
 * Upgrades a manifest document written under an older schema, before
 * validation. Each step is a pure function of the document, so writing the
 * result back persists it.
 */
import { unionOfClaims, type VesselKind } from '../domain/vessel.ts';

type Document = Record<string, unknown>;

function asDocument(value: unknown): Document | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Document)
    : null;
}

/**
 * Returns a current or unrecognized document untouched, so validation reports
 * what arrived. Steps run innermost first, and the order matters.
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
 * Drops the authored `controlPlane` block. Its only key, the hostname, comes
 * from the deployment, and the strict schema refuses even an empty block.
 */
function dropControlPlane(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null || !('controlPlane' in manifest)) return document;
  const { controlPlane: _served, ...rest } = manifest;
  return rest;
}

/**
 * Converts `dns.zones: {private, public}` to the list form. Equal names become
 * one entry serving both reaches; different ones become two, private first.
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
 * Drops `github.clientId`, since the App identity lives in the `github_app`
 * row, and renames `oauthBaseUrl` to `webBaseUrl` unless one is stated.
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
 * The one commit a seed declaration pinned `buildWorkflow` at. Matched exactly:
 * any other ref is an operator's pin.
 */
const SEED_PINNED_WORKFLOW_REF = '@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6';

/**
 * Moves the seed's pinned sha to `@main` and keeps the repository. Runs after
 * {@link scrubPlaceholderBuildWorkflow}: the placeholder ends in the same sha.
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
 * Nulls the chart seed's placeholder workflow, which names a repository this
 * project does not own. Matched exactly: any other value is an operator's pin.
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
 * Turns the string `installation` into the pointer block, taking the first
 * Target's vessel as control plane, and moves the home vessel's scattered keys
 * into its `shared` block. Runs after {@link addDeclaredVessels}.
 */
function nameInstallationVessels(document: unknown): unknown {
  const manifest = asDocument(document);
  if (manifest === null) return document;
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
    // In order, so the upgrade does not read as a reordering diff.
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
 * The vessel whose project `cloud.homeVesselProject` names, else the first
 * cloud project vessel. Never an invented one.
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

/** A non-blank string, or `null`. */
function firstString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Drops each Target's `name`: `vessel` and `adapter` identify it. Runs after
 * {@link addDeclaredVessels}, which reads the names.
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
    // Array position is rank.
    targets: seeds.map((seed) => {
      const target = asDocument(seed);
      if (target === null) return seed;
      const { name: _discarded, ...rest } = target;
      return rest;
    }),
  };
}

/**
 * Adds `vessels` to a document without one, deriving vessel names from Target
 * names as 0022_vessels.sql did. The kind comes from a stated address, else
 * from that backfill.
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
      /** The kind 0022_vessels.sql gave; used when no address is stated. */
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
      // Unrecognized: hand it back whole so validation names the fault.
      return document;
    }

    // A cluster Target's name is its vessel name unchanged, as in the 0022
    // backfill; only cloud surfaces carried an adapter suffix.
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
      // The first surface to state an address settles location and kind.
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
      // Static surfaces never carried this key; `undefined` is unstated, but
      // `[]` would be a stated empty claim.
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
      kind: kind ?? backfilled,
      ...(location === undefined ? {} : { location }),
      // The union of every surface's claim, as the backfill did. Omitted when
      // none stated one, since absent and `[]` differ.
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
    // Array position is rank.
    targets,
  };
}

function stripSuffix(value: string, suffix: string): string {
  return value.endsWith(suffix) ? value.slice(0, -suffix.length) : value;
}

/** `null` when the connection states no address. */
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

function asStrings(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((it) => typeof it === 'string')
    ? value
    : undefined;
}
