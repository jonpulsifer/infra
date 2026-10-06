/**
 * Refreshes each vessel's prerequisite checklist and discovery. A vessel is
 * asked only what `VESSEL_PREREQUISITES_BY_KIND_AND_ROLE` assigns it.
 */
import { eq } from 'drizzle-orm';
import type { Discovered } from '../adapters/cloud-discovery.ts';
import type { SecretStore } from '../adapters/store/contract.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import {
  type InstallationManifest,
  sharedServicesOf,
} from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { type Vessel, vessels } from '../db/schema.ts';
import {
  deriveVesselHealth,
  unreachableVesselPrerequisites,
  type VesselDiscovery,
  type VesselPrerequisite,
  type VesselPrerequisiteResult,
  type VesselRole,
  vesselPrerequisitesFor,
  vesselRolesOf,
} from '../domain/vessel.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';

export interface VesselLoopContext {
  readonly db: Database;
  readonly adapters: Pick<
    AdapterRegistry,
    'discovery' | 'store' | 'cloudflare'
  >;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

// The project and location Cloud KMS lists keys by, parsed from the signer.
const SIGNER_REFERENCE =
  /^gcpkms:\/\/projects\/([^/]+)\/locations\/([^/]+)\/keyRings\//;

// Lists a key never written: both stores answer an absent item with an empty
// list and throw when unreachable or refused, so the probe writes nothing.
const STORE_PROBE = {
  scope: { app: 'spindrift', component: 'checklist', target: 'vessel' },
  key: 'REACHABILITY',
} as const;

export interface VesselRefresh {
  readonly vesselId: string;
  readonly vessel: string;
  readonly health: 'healthy' | 'unhealthy';
  /** Set only when this pass changed a previously assessed health. */
  readonly healthChangedFrom?: 'healthy' | 'unhealthy';
}

export interface VesselInspection {
  readonly prerequisites: readonly VesselPrerequisiteResult[];
  /** `null` when the vessel's kind has no account-wide listing. */
  readonly discovery: VesselDiscovery | null;
}

/** Never throws: a refusing API yields an unmet row, and the pass goes on. */
export async function inspectVessel(
  context: VesselLoopContext,
  vessel: Pick<Vessel, 'name' | 'kind' | 'location'>,
  roles: readonly VesselRole[],
): Promise<VesselInspection> {
  const [prerequisites, discovery] = await Promise.all([
    checklistOf(context, vessel, roles),
    readVesselDiscovery(context.adapters, vessel),
  ]);
  return { prerequisites, discovery };
}

/**
 * `null` for every kind but a Cloudflare account. An unreadable account yields
 * null fields with the reason, never `null`.
 */
export async function readVesselDiscovery(
  adapters: Pick<AdapterRegistry, 'cloudflare'>,
  vessel: Pick<Vessel, 'name' | 'kind' | 'location'>,
): Promise<VesselDiscovery | null> {
  if (vessel.kind !== 'cloudflare-account') return null;
  const location = vessel.location;
  if (location === null || location.kind !== 'cloudflare-account') {
    return unreadableAccount(
      `${vessel.name} states no account, so nothing in it could be listed`,
    );
  }
  const accounts = adapters.cloudflare?.() ?? null;
  if (accounts === null) {
    return unreadableAccount(
      'this installation has no Cloudflare credential, so nothing in this account could be listed',
    );
  }
  return accounts.read(location.account, {
    ...(location.endpoint === undefined ? {} : { endpoint: location.endpoint }),
  });
}

function unreadableAccount(detail: string): VesselDiscovery {
  return {
    kind: 'cloudflare-account',
    zones: null,
    workersSubdomain: null,
    pagesProjects: null,
    unreadable: { account: detail },
  };
}

async function checklistOf(
  context: VesselLoopContext,
  vessel: Pick<Vessel, 'name' | 'kind' | 'location'>,
  roles: readonly VesselRole[],
): Promise<readonly VesselPrerequisiteResult[]> {
  const asked = vesselPrerequisitesFor(vessel.kind, roles);
  if (asked.length === 0) return [];

  const discovery = context.adapters.discovery?.() ?? null;
  if (discovery === null) {
    return unreachableVesselPrerequisites(
      'this process cannot reach a cloud API, so nothing about this boundary could be established',
      vessel.kind,
      roles,
    );
  }
  const location = vessel.location;
  if (location === null || location.kind !== 'gcp-project') {
    // Only a GCP project is asked these, so this row does not yet state one.
    return unreachableVesselPrerequisites(
      `${vessel.name} states no project, so its shared services could not be looked for`,
      vessel.kind,
      roles,
    );
  }

  const shared = sharedServicesOf(context.manifest);
  const signer = SIGNER_REFERENCE.exec(context.manifest.supplyChain.signer);
  // `GcpDiscovery` returns failures instead of throwing, so each read folds
  // into its own row.
  const [buckets, projects, keys, store] = await Promise.all([
    discovery.buckets(location.project),
    discovery.projects(),
    signer === null
      ? notAskable(
          'supplyChain.signer is not a Cloud KMS key reference, so no key location could be read from it',
        )
      : discovery.signingKeys(signer[1]!, signer[2]!),
    storeReach(context.adapters.store(context.manifest.secretStore.adapter)),
  ]);

  const answers: Record<VesselPrerequisite, VesselPrerequisiteResult> = {
    SOURCE_BUCKET: holds(
      'SOURCE_BUCKET',
      buckets,
      shared.sourceBucket,
      `${shared.sourceBucket} is not a bucket in ${location.project}`,
    ),
    SECRET_STORE: store,
    SIGNER_KEY: holds(
      'SIGNER_KEY',
      keys,
      context.manifest.supplyChain.signer,
      'no signing key with that reference is in this location, or its purpose is not signing',
    ),
    ARTIFACTS_PROJECT: holds(
      'ARTIFACTS_PROJECT',
      projects,
      shared.artifactsProject,
      `${shared.artifactsProject} is not a project this identity can see`,
    ),
  };
  return asked.map((name) => answers[name]);
}

function notAskable(reason: string): Promise<Discovered<string>> {
  return Promise.resolve({ kind: 'unavailable', reason });
}

/**
 * A refused read (`assessed: false`) stays apart from an established absence,
 * so a mistyped bucket and an unreachable API never read the same.
 */
function holds(
  name: VesselPrerequisite,
  listed: Discovered<string>,
  value: string,
  absent: string,
): VesselPrerequisiteResult {
  if (listed.kind === 'unavailable') {
    return { name, met: false, assessed: false, detail: listed.reason };
  }
  return listed.candidates.includes(value)
    ? { name, met: true }
    : { name, met: false, detail: absent };
}

async function storeReach(
  store: SecretStore | null,
): Promise<VesselPrerequisiteResult> {
  if (store === null) {
    return {
      name: 'SECRET_STORE',
      met: false,
      assessed: false,
      detail:
        'this installation has no adapter for the secret store its manifest names',
    };
  }
  try {
    await store.versions(STORE_PROBE.scope, STORE_PROBE.key);
    return { name: 'SECRET_STORE', met: true };
  } catch (cause) {
    // A throw is the store declining to be read, not a fact about its contents.
    return {
      name: 'SECRET_STORE',
      met: false,
      assessed: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * Every vessel: an app vessel stores an empty checklist, which reads as
 * assessed and asked nothing, where `null` is never assessed.
 */
export async function refreshAllVessels(
  context: VesselLoopContext,
): Promise<readonly VesselRefresh[]> {
  const rows = await context.db.select().from(vessels);
  const refreshed: VesselRefresh[] = [];

  for (const vessel of rows) {
    const roles = vesselRolesOf(context.manifest, vessel.name);
    const before =
      vessel.prerequisites === null
        ? null
        : deriveVesselHealth(vessel.prerequisites, vessel.kind, roles);
    // Sequential, so a fleet refresh never herds every control plane at once.
    const { prerequisites, discovery } = await inspectVessel(
      context,
      vessel,
      roles,
    );
    const now = context.clock.now();
    await context.db
      .update(vessels)
      .set({ prerequisites, discovery, inspectedAt: now, updatedAt: now })
      .where(eq(vessels.id, vessel.id));

    const health = deriveVesselHealth(prerequisites, vessel.kind, roles);
    refreshed.push({
      vesselId: vessel.id,
      vessel: vessel.name,
      health,
      ...(before === null || before === health
        ? {}
        : { healthChangedFrom: before }),
    });
  }
  return refreshed;
}

export interface VesselLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (refreshed: readonly VesselRefresh[]) => void;
}

export async function runVesselLoop(
  context: VesselLoopContext,
  options: VesselLoopOptions,
): Promise<void> {
  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    const refreshed = await refreshAllVessels(context);
    reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
      loop: 'vessel',
    });
    options.onPass?.(refreshed);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs, options.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
