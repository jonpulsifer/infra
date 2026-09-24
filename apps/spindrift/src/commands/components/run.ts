/**
 * Starts one run of a placed job from the ref its newest Deploy stored, and
 * writes nothing: runs live on the platform. Parameters add env vars and never
 * override delivered config, which would put a sealed value inline.
 */
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { JobExecution } from '../../adapters/deploy/contract.ts';
import { deploys, targets, vessels } from '../../db/schema.ts';
import { VARIABLE_NAME } from '../../domain/config.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  targetLabel,
} from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

/** A parameter is a snapshot name or a date, never a document. */
export const RUN_PARAMETER_LIMIT = 4_096;

export const runComponentInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /**
     * Names are checked in the handler, so a bad one gets config's sentence
     * instead of zod's record-key error.
     */
    env: z.record(z.string(), z.string().max(RUN_PARAMETER_LIMIT)).optional(),
  })
  .strict();

export type RunComponentInput = z.infer<typeof runComponentInput>;

export interface RunComponentResult {
  readonly execution: JobExecution;
}

export const runComponent: Command<
  RunComponentInput,
  RunComponentResult
> = async (input, context) => {
  const [component] = await context.db.query.components.findMany({
    where: (components, { eq }) => eq(components.id, input.componentId),
    limit: 1,
  });
  if (!component) {
    return failed('NOT_FOUND', 'that Component does not exist');
  }
  // Checked here as well as by the adapter, so the refusal names the Component
  // instead of the object a ref names.
  if (component.kind !== 'job') {
    return failed(
      'NOT_RUNNABLE',
      `${component.name} is a ${component.kind}, and only a job has runs`,
    );
  }

  const [placed] = await context.db
    .select({
      ref: deploys.ref,
      desired: deploys.desired,
      target: targets,
      vessel: vessels,
    })
    .from(deploys)
    .innerJoin(targets, eq(deploys.targetId, targets.id))
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(
      and(
        eq(deploys.componentId, input.componentId),
        eq(deploys.targetId, input.targetId),
      ),
    )
    // The newest Deploy only: an older ref may name a workload a re-place has
    // since moved.
    .orderBy(desc(deploys.id))
    .limit(1);

  if (!placed || placed.ref === null) {
    return failed(
      'NOT_RUNNABLE',
      `${component.name} has not been placed on that Target yet, so there is nothing to run`,
    );
  }
  if (
    !hasTargetConnection(placed.target) ||
    !hasVesselLocation(placed.vessel)
  ) {
    return failed(
      'NOT_RUNNABLE',
      `${targetLabel({ vessel: placed.vessel.name, adapter: placed.target.adapter })} is not connected, so nothing can be started on it`,
    );
  }
  const adapter = context.adapters.deploy(placed.target.adapter);
  if (adapter === null) {
    return failed(
      'NOT_RUNNABLE',
      `this installation has no ${placed.target.adapter} adapter`,
    );
  }

  const env = input.env ?? {};
  const misnamed = Object.keys(env).filter((name) => !VARIABLE_NAME.test(name));
  if (misnamed.length > 0) {
    return failed(
      'INVALID_INPUT',
      `${misnamed.join(', ')} must be an environment variable name`,
    );
  }
  // Read off the placed document, not the config rows, which may have moved since.
  const delivered = new Set([
    ...placed.desired.config.map((entry) => entry.name),
    ...(placed.desired.datastores ?? []).map((entry) => entry.name),
  ]);
  const shadowed = Object.keys(env).filter((name) => delivered.has(name));
  if (shadowed.length > 0) {
    return failed(
      'INVALID_INPUT',
      `${shadowed.join(', ')} ${shadowed.length === 1 ? 'is' : 'are'} already delivered to ${component.name} as config; a run's parameters add to that and never override it`,
    );
  }

  let started: Awaited<ReturnType<typeof adapter.run>>;
  try {
    started = await adapter.run(
      deployTargetOf(placed.target, placed.vessel),
      placed.ref,
      Object.keys(env).length === 0 ? undefined : { env },
    );
  } catch (cause) {
    return failed(
      'NOT_RUNNABLE',
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  if (started.kind === 'none') {
    return failed('NOT_RUNNABLE', started.because);
  }
  return ok({ execution: started.execution });
};
