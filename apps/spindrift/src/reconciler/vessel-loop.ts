/**
 * The Vessel loop — the standing checklist for a boundary rather than for a
 * surface on one (§13, §14).
 *
 * §13's checklist was written about a Target, and this installation depends on
 * four facts that are not any Target's: the bucket a build stages into before a
 * placement is even known, the artifacts project shared across every vessel, the
 * one store of record every Target reads a copy of, and the signer core calls.
 * They belong to the vessel `installation.homeVessel` names, and until this loop
 * ran nothing checked any of them — the failure mode `cloud-discovery.ts` names:
 *
 * > A mistyped project or bucket is invisible until a build stages a source
 * > archive and fails on a signed URL.
 *
 * A separate loop from the Target one rather than a second pass inside it,
 * because it asks entirely different far sides — Cloud Storage, Resource
 * Manager, Cloud KMS and the secret store — rather than a deploy adapter. §13's
 * "one loop, not two" is an argument about health and capabilities being one
 * question of one adapter, and that argument does not reach across the seam.
 *
 * **What it asks is the catalogue, and nothing else.**
 * `VESSEL_PREREQUISITES_BY_KIND_AND_ROLE` decides which rows a vessel gets, so
 * an app vessel is asked nothing and stores an empty checklist — never a green
 * row for something nobody checked. It stores what was observed and never what
 * was concluded: health is derived at read time, exactly as a Target's is.
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

/** What the loop needs. No principal: nobody asked for it to run. */
export interface VesselLoopContext {
  readonly db: Database;
  readonly adapters: Pick<
    AdapterRegistry,
    'discovery' | 'store' | 'cloudflare'
  >;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

/**
 * A KMS key reference as `supplyChain.signer` carries it, split into the two
 * segments Cloud KMS lists keys by.
 *
 * Parsed rather than asked for separately: the manifest already names the key in
 * full, and a second pair of keys beside it would be two values that can
 * disagree about one.
 */
const SIGNER_REFERENCE =
  /^gcpkms:\/\/projects\/([^/]+)\/locations\/([^/]+)\/keyRings\//;

/**
 * The scope a store reachability probe reads under.
 *
 * A listing rather than a write, and of a key that has never been written: both
 * stores answer an absent item with an empty list and answer an unreachable
 * endpoint, a refused credential or a container that does not exist by throwing.
 * That difference is the whole probe — it exercises the exact path core writes
 * over, credential included, without putting anything in the store.
 */
const STORE_PROBE = {
  scope: { app: 'spindrift', component: 'checklist', target: 'vessel' },
  key: 'REACHABILITY',
} as const;

/** One vessel's checklist, and the row it was written to. */
export interface VesselRefresh {
  readonly vesselId: string;
  readonly vessel: string;
  readonly health: 'healthy' | 'unhealthy';
  /** Set when this pass changed what the boundary reports. */
  readonly healthChangedFrom?: 'healthy' | 'unhealthy';
}

/** What one pass established about a boundary: the verdict and the inventory. */
export interface VesselInspection {
  readonly prerequisites: readonly VesselPrerequisiteResult[];
  /** `null` for a boundary whose kind has no account-wide listing to read. */
  readonly discovery: VesselDiscovery | null;
}

/**
 * Ask one boundary the questions its kind and roles put to it.
 *
 * Two independent questions, concurrently: whether this installation can use
 * the boundary (the checklist) and what is in it (the inventory). They are not
 * one call because they are not one verdict — an account with no zones is
 * perfectly usable, and a checklist row saying otherwise would be a rule nobody
 * wrote.
 *
 * Never throws, for the reason `inspectTarget` does not: the far sides here are
 * other people's APIs, and one refusing must produce an unmet row with its
 * sentence rather than stop the pass.
 */
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
 * What the boundary holds, as its own credential can see it.
 *
 * `null` rather than an empty document for every kind that has none: a cluster
 * and a cloud project are read by the checklist above and by the Target loop,
 * and neither has an account-wide inventory this shape would carry. A stored
 * `null` there is "there is nothing of this kind to read", which is a different
 * fact from a Cloudflare account whose reads were all refused — that one stores
 * a document with three null fields and three sentences.
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

/** The inventory of an account nothing could ask, with the fault stated. */
function unreadableAccount(detail: string): VesselDiscovery {
  return {
    kind: 'cloudflare-account',
    zones: null,
    workersSubdomain: null,
    pagesProjects: null,
    unreadable: { account: detail },
  };
}

/** §13's checklist, one noun up — the four facts a home vessel owes. */
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
    // The catalogue only asks these of a `gcp-project`, so this is a boundary
    // whose row does not yet say where it is — the half-ready state §13 intends
    // to be visible rather than one to fabricate a project id for.
    return unreachableVesselPrerequisites(
      `${vessel.name} states no project, so its shared services could not be looked for`,
      vessel.kind,
      roles,
    );
  }

  const shared = sharedServicesOf(context.manifest);
  const signer = SIGNER_REFERENCE.exec(context.manifest.supplyChain.signer);
  // Four independent reads, each folded into its own row. Never one `try` and
  // never one rejection path: `GcpDiscovery` returns its failures, so a single
  // catch would turn three good answers into four refusals.
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

/** A read that was never made, in the arm a refused one comes back in. */
function notAskable(reason: string): Promise<Discovered<string>> {
  return Promise.resolve({ kind: 'unavailable', reason });
}

/**
 * One checklist row from one listing.
 *
 * The two arms stay apart all the way to the row: an established absence says
 * the value is not there, and a refused read says nothing was established.
 * Collapsing them would report a mistyped bucket and an unreachable API with the
 * same sentence, which is the laundering `cloud-discovery.ts` exists to prevent.
 *
 * `assessed` is that same split as a field rather than as prose, so a reader
 * downstream keeps it without matching on the sentence: a refused listing must
 * not produce a stanza declaring a bucket nobody established was missing.
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

/** Whether the configured store answered at all. */
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
    // Both stores answer an absent item with an empty list and throw for
    // everything else, so a throw here is the store declining to be read
    // rather than a fact about what is in it.
    return {
      name: 'SECRET_STORE',
      met: false,
      assessed: false,
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/**
 * One pass over every vessel.
 *
 * Every one of them, not only the two the installation is built on: an app
 * vessel is asked nothing, so its pass is one write of an empty checklist, and
 * that empty list is what makes "assessed and asked nothing" a different stored
 * state from "never assessed".
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
    // Sequential rather than concurrent, exactly as the Target loop is: the far
    // sides are other people's control planes, and a fleet refreshing in
    // lockstep is a thundering herd against every one of them at once.
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

/** How often the loop runs, and how to stop it. */
export interface VesselLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (refreshed: readonly VesselRefresh[]) => void;
}

/** Run the loop until aborted. Poll, not watch — see `target-loop.ts`. */
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

/** A sleep that wakes early on abort rather than holding the loop open. */
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
