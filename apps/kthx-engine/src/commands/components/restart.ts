/**
 * Restarts a placed service's process without writing a Deploy row. Only a LIVE
 * newest release is bounced, and the restart is logged on that Deploy.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { deploys, targets, vessels } from '../../db/schema.ts';
import { recordDeployEvent } from '../../domain/attempt-log.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetLabel,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

export const restartComponentInput = z
  .object({
    componentId: z.uuid(),
    /** Optional while the Component is placed once; required once there are two. */
    targetId: z.uuid().optional(),
  })
  .strict();

export type RestartComponentInput = z.infer<typeof restartComponentInput>;

export interface RestartComponentResult {
  /** The release whose log records the restart. */
  readonly deployId: number;
  /** As `<vessel>/<adapter>`. */
  readonly target: string;
  /** The adapter's sentence about what rolls. */
  readonly detail: string;
}

export const restartComponent: Command<
  RestartComponentInput,
  RestartComponentResult
> = async (input, context) => {
  const [component] = await context.db.query.components.findMany({
    where: (components, { eq }) => eq(components.id, input.componentId),
    limit: 1,
  });
  if (!component) {
    return failed('NOT_FOUND', 'that Component does not exist');
  }
  if (component.kind === 'job') {
    return failed(
      'NOT_RESTARTABLE',
      `${component.name} is a job, which has runs rather than a process to restart — use Run now`,
    );
  }

  const rows = await context.db
    .select({
      id: deploys.id,
      phase: deploys.phase,
      ref: deploys.ref,
      target: targets,
      vessel: vessels,
    })
    .from(deploys)
    .innerJoin(targets, eq(deploys.targetId, targets.id))
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(
      and(
        eq(deploys.componentId, input.componentId),
        input.targetId === undefined
          ? undefined
          : eq(deploys.targetId, input.targetId),
      ),
    )
    .orderBy(desc(deploys.id));

  // The newest Deploy on each Target says what is there now. An older LIVE row
  // behind a newer intent is about to be replaced.
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (!newest.has(row.target.id)) newest.set(row.target.id, row);
  }
  const candidates = [...newest.values()];
  if (candidates.length === 0) {
    return failed(
      'NOT_RESTARTABLE',
      `${component.name} has not been placed on a Target yet, so there is nothing to restart`,
    );
  }
  if (candidates.length > 1) {
    return failed(
      'NOT_RESTARTABLE',
      `${component.name} is placed on ${candidates.length} Targets (${candidates
        .map((row) => labelOf(row))
        .sort()
        .join(', ')}) — say which one to restart`,
    );
  }
  const placed = candidates[0]!;
  if (placed.phase !== 'LIVE' || placed.ref === null) {
    return failed(
      'NOT_RESTARTABLE',
      `the newest release of ${component.name} on ${labelOf(placed)} is ${placed.phase}, not LIVE — a restart bounces what a live release placed`,
    );
  }
  if (
    !hasTargetConnection(placed.target) ||
    !hasVesselLocation(placed.vessel)
  ) {
    return failed(
      'NOT_RESTARTABLE',
      `${labelOf(placed)} is not connected, so nothing can be restarted on it`,
    );
  }
  const adapter = context.adapters.deploy(placed.target.adapter);
  if (adapter === null) {
    return failed(
      'NOT_RESTARTABLE',
      `this installation has no ${placed.target.adapter} adapter`,
    );
  }

  let restarted: Awaited<ReturnType<typeof adapter.restart>>;
  try {
    restarted = await adapter.restart(
      deployTargetOf(placed.target, placed.vessel),
      placed.ref,
    );
  } catch (cause) {
    return failed(
      'NOT_RESTARTABLE',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (restarted.kind === 'none') {
    return failed('NOT_RESTARTABLE', restarted.because);
  }

  const attempt = {
    appId: component.appId,
    componentId: component.id,
    deployId: placed.id,
  };
  await recordDeployEvent(context.db, attempt, {
    type: 'log',
    line: `restart asked for by ${context.principal.displayName}: ${restarted.detail}`,
  });
  await recordDeployEvent(context.db, attempt, {
    type: 'status',
    phase: 'RESTARTED',
  });

  return ok({
    deployId: placed.id,
    target: labelOf(placed),
    detail: restarted.detail,
  });
};

function labelOf(row: {
  readonly target: {
    readonly adapter: (typeof targets.$inferSelect)['adapter'];
  };
  readonly vessel: { readonly name: string };
}): string {
  return targetLabel({ vessel: row.vessel.name, adapter: row.target.adapter });
}
