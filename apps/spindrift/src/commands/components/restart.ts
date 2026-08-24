/**
 * `restartComponent` — replace a placed service's running process (§6).
 *
 * Redeploying what is already desired is refused as `UNCHANGED`, and rightly:
 * a deploy is an intent to change the desired row, and a wedged process
 * changed nothing about it. This is the act for the case that refusal leaves
 * nobody with — a service that needs bouncing, on a platform where `kubectl`
 * is not an authoring path — and it is a command beside `runComponent` for
 * the reason `DeployAdapter.restart` is a verb beside `run`: something an
 * operator asks for once, against what is placed.
 *
 * **It writes no Deploy row.** §6's one timeline is a timeline of attempts,
 * and a restart is not an attempt: the desired row is untouched, the artifact
 * is untouched, and the platform rolls what it already holds. A second Deploy
 * row would be an intent that intends nothing, refused by the very rule this
 * exists beside. What it writes instead is two events on the *current*
 * Deploy's leg of the attempt log — the adapter's sentence, which the release
 * page shows, and a `RESTARTED` checkpoint, which the workspace lists —
 * because the release that placed what was bounced is where a reader looks
 * for what happened to it.
 *
 * **Only a LIVE newest release is bounced.** A Deploy still applying is a
 * rollout this would race; a FAILED one never converged, which a restart
 * cannot fix and a deploy can. A job is refused outright: it has runs rather
 * than a process, and `Run now` is its act.
 *
 * **The ref decides what is bounced**, as for `run`: the handle `apply`
 * returned and core stored, so what rolls is what is placed.
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
    /**
     * Which placement to bounce. Optional because the ordinary Component is
     * placed once, and a screen showing that one pair should not have to say
     * so; required in effect the moment there are two, since a restart aimed
     * at "wherever" is a restart of something the operator did not name.
     */
    targetId: z.uuid().optional(),
  })
  .strict();

export type RestartComponentInput = z.infer<typeof restartComponentInput>;

export interface RestartComponentResult {
  /** The release whose process was bounced, and whose log now says so. */
  readonly deployId: number;
  /** Where, as `<vessel>/<adapter>`. */
  readonly target: string;
  /** The adapter's own sentence about what it stamped and what rolls. */
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

  // The newest Deploy on each Target is the one whose phase says what is
  // there now: an older LIVE row behind a newer intent is a release about to
  // be replaced, not one to bounce.
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

  // The adapter refuses in a sentence and throws on a fault, and the two are
  // reported as two things for the reason `runComponent` gives: a refusal is
  // the operator's to act on and a fault is the far side's.
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
