/**
 * Refreshes each connected Target's prerequisite checklist and discovery.
 * `capabilities.ts` derives `verifiedDeploy` and `offlineDeploy` at read time.
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
  targetLabel,
  unstatedAddress,
} from '../domain/target.ts';
import type { SurfaceProbe } from '../domain/vessel.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';

export interface TargetLoopContext {
  readonly db: Database;
  readonly adapters: Pick<AdapterRegistry, 'deploy'>;
  readonly clock: Clock;
}

export interface TargetInspectionResult {
  readonly prerequisites: readonly PrerequisiteResult[];
  /** `null` when the Target is unreachable or has no adapter. */
  readonly discovery: TargetDiscovery | null;
  /** Only connect acts on this; the loop never adds or removes a Target. */
  readonly surface: SurfaceProbe;
}

/** Never throws, so one bad Target cannot fail connect or a pass. */
export async function inspectTarget(
  context: TargetLoopContext,
  target: DeployTargetRef,
): Promise<TargetInspectionResult> {
  const deployAdapter = context.adapters.deploy(target.adapter);
  if (deployAdapter === null) {
    // Not a fault: an installation may hold a Target whose adapter it lacks.
    const detail = `this installation has no ${target.adapter} adapter`;
    return {
      prerequisites: unreachablePrerequisites(detail, target.adapter),
      discovery: null,
      // Undetermined, not absent: nobody asked the boundary anything.
      surface: { kind: 'undetermined', detail },
    };
  }
  const unstated = unstatedAddress(target);
  if (unstated !== null) {
    // The vessel's location lacks this surface's address, so the checklist
    // names the missing address instead of asking about `undefined`.
    return {
      prerequisites: unreachablePrerequisites(unstated, target.adapter),
      discovery: null,
      surface: { kind: 'undetermined', detail: unstated },
    };
  }
  try {
    const inspection = await deployAdapter.inspect(target);
    return {
      prerequisites: inspection.prerequisites,
      discovery: inspection.discovery,
      surface: inspection.surface,
    };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return {
      prerequisites: unreachablePrerequisites(detail, target.adapter),
      discovery: null,
      surface: { kind: 'undetermined', detail },
    };
  }
}

/**
 * Reconnects disconnected Targets the manifest declares, before the loops
 * start. Storing the manifest cannot: without adapters nothing re-adopts.
 */
export async function restoreDeclaredTargetConnections(
  context: TargetLoopContext,
  manifest: InstallationManifest,
): Promise<readonly string[]> {
  const declared = new Set(
    manifest.targets.flatMap((target) =>
      target.connection === undefined ? [] : [targetLabel(target)],
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
      !declared.has(
        targetLabel({ vessel: vessel.name, adapter: target.adapter }),
      ) ||
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

/** Re-adopts orphaned Deploys `observe` still finds; the rest stay orphaned. */
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

export interface TargetRefresh {
  readonly targetId: string;
  /** `<vessel>/<adapter>` */
  readonly target: string;
  readonly health: TargetHealth;
  /** Set only when this pass changed the Target's health. */
  readonly healthChangedFrom?: TargetHealth;
}

/**
 * Never writes `status` or acts on `surface`: both are operator acts, and a
 * disconnect must not undo itself when the cluster returns.
 */
export async function refreshTarget(
  context: TargetLoopContext,
  target: Pick<Target, 'id' | 'adapter' | 'health' | 'connection'>,
  vessel: Pick<
    Vessel,
    'name' | 'location' | 'servedHosts' | 'reachableRegistries'
  >,
): Promise<TargetRefresh> {
  const label = targetLabel({ vessel: vessel.name, adapter: target.adapter });
  if (!hasTargetConnection(target)) {
    throw new Error(`Target ${label} has no connection to refresh`);
  }
  if (!hasVesselLocation(vessel)) {
    throw new Error(`Target ${label} sits on a vessel with no location`);
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
    target: label,
    health,
    ...(health === target.health ? {} : { healthChangedFrom: target.health }),
  };
}

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
    // Defensive: a manifest seed starts disconnected, so only a bad row fails.
    if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) continue;
    // Sequential, so a fleet refresh never herds every control plane at once.
    refreshed.push(await refreshTarget(context, target, vessel));
  }
  return refreshed;
}

export interface TargetLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly onPass?: (refreshed: readonly TargetRefresh[]) => void;
}

// Polls: a watch across a WAN tunnel can stop delivering without an error.
export async function runTargetLoop(
  context: TargetLoopContext,
  options: TargetLoopOptions,
): Promise<void> {
  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    const refreshed = await refreshAllTargets(context);
    reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
      loop: 'target',
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
