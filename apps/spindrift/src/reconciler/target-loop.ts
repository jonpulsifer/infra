/**
 * The Target loop (§13, §3).
 *
 * **One loop, not two.** §13: "health is a standing prerequisite checklist...
 * which merges capability refresh and health into one loop." §3 wants the same
 * thing from the other side: "discovered by default, asserted only where
 * discovery is impossible, **refreshed on a schedule** — a connect-time snapshot
 * rots, and the symptom is a Target disabled long after it stopped being
 * incapable." Both are answered by one pass that asks each Target's adapter one
 * question and writes back what it said.
 *
 * The loop **never draws a conclusion**. It stores the checklist and the raw
 * discovery; `verifiedDeploy` and `offlineDeploy` are derived at read time by
 * `capabilities.ts`, so a manifest change that moves the chart off-Target
 * changes `offlineDeploy` without waiting for a refresh, and a stored derivation
 * can never be stale in a way nothing notices.
 *
 * `inspectTarget` is exported because the connect act runs exactly one pass of
 * it (§13: connect always succeeds, and what it succeeds *at* is this). Two code
 * paths that both decided what "healthy" means would be the two loops §13 says
 * this is not.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import {
  deploys,
  type Target,
  targets,
  type Vessel,
  vessels,
} from '../db/schema.ts';
import {
  deriveHealth,
  type PrerequisiteResult,
  type TargetDiscovery,
  unreachablePrerequisites,
} from '../domain/capabilities.ts';
import {
  type DeployTargetRef,
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  type TargetHealth,
} from '../domain/target.ts';

/**
 * What the loop needs. Narrower than a `CommandContext` on purpose — the loop
 * has no principal, because nobody asked for it to run.
 */
export interface TargetLoopContext {
  readonly db: Database;
  readonly adapters: Pick<AdapterRegistry, 'deploy'>;
  readonly clock: Clock;
}

/** One pass's answer for one Target. */
export interface TargetInspectionResult {
  readonly prerequisites: readonly PrerequisiteResult[];
  /** `null` when nothing could be discovered — unreachable, or no adapter. */
  readonly discovery: TargetDiscovery | null;
}

/**
 * Ask one Target's adapter for the checklist and the discovery.
 *
 * Never throws. §13's "connect always succeeds" and the loop's own need to
 * survive one bad Target are the same requirement: an adapter that is allowed to
 * throw meets core in exactly one place, and this is it.
 */
export async function inspectTarget(
  context: TargetLoopContext,
  target: DeployTargetRef,
): Promise<TargetInspectionResult> {
  const deployAdapter = context.adapters.deploy(target.adapter);
  if (deployAdapter === null) {
    // Not a fault: an installation is allowed to have a Target whose adapter it
    // does not ship. It is simply a Target nothing can be placed on, and saying
    // so is more useful than refusing to record it.
    return {
      prerequisites: unreachablePrerequisites(
        `this installation has no ${target.adapter} adapter`,
        target.adapter,
      ),
      discovery: null,
    };
  }
  try {
    const inspection = await deployAdapter.inspect(target);
    return {
      prerequisites: inspection.prerequisites,
      discovery: inspection.discovery,
    };
  } catch (cause) {
    return {
      prerequisites: unreachablePrerequisites(
        cause instanceof Error ? cause.message : String(cause),
        target.adapter,
      ),
      discovery: null,
    };
  }
}

/**
 * Restore connections owned by installation desired state before loops start.
 *
 * A disconnected row is deliberately left disconnected while the manifest is
 * stored: adapters do not exist at that point, so reconnecting there would
 * strand orphaned Deploys permanently. Once adapters exist, this performs the
 * same inspect-and-readopt transition as an in-product reconnect.
 */
export async function restoreDeclaredTargetConnections(
  context: TargetLoopContext,
  manifest: InstallationManifest,
): Promise<readonly string[]> {
  const declared = new Set(
    manifest.targets.flatMap((target) =>
      target.connection === undefined ? [] : [target.name],
    ),
  );
  if (declared.size === 0) return [];

  const disconnected = await context.db
    .select({ target: targets, vessel: vessels })
    .from(targets)
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(targets.status, 'disconnected'));
  const readopted: string[] = [];

  for (const { target, vessel } of disconnected) {
    if (
      !declared.has(target.name) ||
      !hasTargetConnection(target) ||
      !hasVesselLocation(vessel)
    ) {
      continue;
    }

    const now = context.clock.now();
    const ref = deployTargetOf(target, vessel);
    const { prerequisites, discovery } = await inspectTarget(context, ref);
    const health = deriveHealth(prerequisites, target.adapter);
    await context.db
      .update(targets)
      .set({
        status: 'connected',
        health,
        prerequisites,
        discovery,
        inspectedAt: now,
        updatedAt: now,
      })
      .where(eq(targets.id, target.id));
    readopted.push(
      ...(await readoptTargetDeploys(context, target.id, ref, now)),
    );
  }

  return readopted;
}

/**
 * Re-adopt what a disconnect stranded (§13).
 *
 * The adapter's `observe` is authoritative. A workload still present is
 * adopted; one that disappeared or cannot be observed stays orphaned.
 */
export async function readoptTargetDeploys(
  context: TargetLoopContext,
  targetId: string,
  target: DeployTargetRef,
  now: Date,
): Promise<string[]> {
  const deployAdapter = context.adapters.deploy(target.adapter);
  if (deployAdapter === null) return [];

  const stranded = await context.db
    .select()
    .from(deploys)
    .where(
      and(
        eq(deploys.targetId, targetId),
        isNotNull(deploys.orphanedAt),
        isNotNull(deploys.ref),
      ),
    );

  const adopted: string[] = [];
  for (const deploy of stranded) {
    let observed: Awaited<ReturnType<typeof deployAdapter.observe>>;
    try {
      observed = await deployAdapter.observe(target, deploy.ref!);
    } catch {
      continue;
    }
    if (observed === null) continue;

    await context.db
      .update(deploys)
      .set({ orphanedAt: null, phase: observed.phase, updatedAt: now })
      .where(eq(deploys.id, deploy.id));
    adopted.push(String(deploy.id));
  }
  return adopted;
}

/** What one Target's refresh did. */
export interface TargetRefresh {
  readonly targetId: string;
  readonly name: string;
  readonly health: TargetHealth;
  /** Set when this pass changed the Target's health. */
  readonly healthChangedFrom?: TargetHealth;
}

/**
 * Refresh one Target row from one inspection.
 *
 * Writes the checklist, the discovery, and the derived health — and nothing
 * else. In particular it does not touch `status`: connected and disconnected are
 * the operator's statement about a Target, and a loop that could flip them would
 * make a disconnect undo itself the moment the cluster came back.
 */
export async function refreshTarget(
  context: TargetLoopContext,
  target: Pick<Target, 'id' | 'name' | 'adapter' | 'health' | 'connection'>,
  /** The boundary half of what the adapter is handed. */
  vessel: Pick<Vessel, 'location' | 'servedHosts' | 'reachableRegistries'>,
): Promise<TargetRefresh> {
  if (!hasTargetConnection(target)) {
    throw new Error(`Target ${target.name} has no connection to refresh`);
  }
  if (!hasVesselLocation(vessel)) {
    throw new Error(`Target ${target.name} sits on a vessel with no location`);
  }
  const now = context.clock.now();
  const { prerequisites, discovery } = await inspectTarget(
    context,
    deployTargetOf(target, vessel),
  );
  const health = deriveHealth(prerequisites, target.adapter);

  await context.db
    .update(targets)
    .set({
      prerequisites,
      discovery,
      health,
      inspectedAt: now,
      updatedAt: now,
    })
    .where(eq(targets.id, target.id));

  return {
    targetId: target.id,
    name: target.name,
    health,
    ...(health === target.health ? {} : { healthChangedFrom: target.health }),
  };
}

/**
 * One pass over every connected Target.
 *
 * Disconnected Targets are skipped: §13 says a disconnect strands workloads
 * without stopping them, and continuing to poll a Target the operator removed
 * would keep a cluster's API server in the loop's hot path for as long as the
 * row survives.
 */
export async function refreshAllTargets(
  context: TargetLoopContext,
): Promise<readonly TargetRefresh[]> {
  const connected = await context.db
    .select({ target: targets, vessel: vessels })
    .from(targets)
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(targets.status, 'connected'));

  const refreshed: TargetRefresh[] = [];
  for (const { target, vessel } of connected) {
    // A manifest seed is disconnected, so this is defensive against a
    // malformed row rather than part of the ordinary bootstrap path.
    if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) continue;
    // Sequential rather than concurrent: the far sides are other people's
    // control planes, and a fleet of Targets refreshing in lockstep is a
    // thundering herd against every one of them at once.
    refreshed.push(await refreshTarget(context, target, vessel));
  }
  return refreshed;
}

/** How often the loop runs, and how to stop it. */
export interface TargetLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  /** Called after each pass — where an installation wires logging or metrics. */
  readonly onPass?: (refreshed: readonly TargetRefresh[]) => void;
}

/**
 * Run the loop until aborted.
 *
 * Poll, not watch. Only one of the three backends has a watch to subscribe to,
 * and a watch held across a satellite uplink dies quietly and stops delivering
 * without saying so — which is exactly the failure mode a capability refresh
 * must not have.
 */
export async function runTargetLoop(
  context: TargetLoopContext,
  options: TargetLoopOptions,
): Promise<void> {
  while (!options.signal?.aborted) {
    const refreshed = await refreshAllTargets(context);
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
