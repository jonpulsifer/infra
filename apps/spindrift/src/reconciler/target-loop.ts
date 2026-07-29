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
import { eq } from 'drizzle-orm';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { type Target, targets } from '../db/schema.ts';
import {
  deriveHealth,
  type PrerequisiteResult,
  type TargetDiscovery,
  unreachablePrerequisites,
} from '../domain/capabilities.ts';
import {
  type DeployTargetRef,
  deployTargetOf,
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
): Promise<TargetRefresh> {
  const connection = target.connection;
  if (connection === null) {
    throw new Error(`Target ${target.name} has no connection to refresh`);
  }
  const now = context.clock.now();
  const { prerequisites, discovery } = await inspectTarget(
    context,
    deployTargetOf({ ...target, connection }),
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
    .select()
    .from(targets)
    .where(eq(targets.status, 'connected'));

  const refreshed: TargetRefresh[] = [];
  for (const target of connected) {
    // A manifest seed is disconnected, so this is defensive against a
    // malformed row rather than part of the ordinary bootstrap path.
    if (target.connection === null) continue;
    // Sequential rather than concurrent: the far sides are other people's
    // control planes, and a fleet of Targets refreshing in lockstep is a
    // thundering herd against every one of them at once.
    refreshed.push(await refreshTarget(context, target));
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
