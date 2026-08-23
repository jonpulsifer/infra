/**
 * `runComponent` — start one run of a job, now (§17).
 *
 * §7 makes a job's `apply` two acts: the chart renders a CronJob that exists
 * and is triggered by nothing, and something has to trigger it. This is that
 * something, and it is a command rather than a mode on `deployApp` for the
 * reason `DeployAdapter.run` is a verb rather than a mode on `apply` — a deploy
 * is convergent and happens whenever desired state moves, while a run is an act
 * an operator asked for once.
 *
 * **It writes nothing.** No Deploy row, no attempt, no event. A run is not an
 * attempt: §6's phases describe placing a workload, and a job that exits 1 is
 * not a release that went red — the CronJob is still exactly as live as it was.
 * The runs themselves live on the platform (§17: "configure the platform, don't
 * build it"), which is where `getAppWorkspace` reads them back from, so a row
 * here would be a second history that could only disagree with the first.
 *
 * **The ref decides what runs.** It is the handle `apply` returned and core
 * stored (§6), so what starts is the workload that is actually placed — never a
 * description assembled a second time from rows that may have moved since.
 *
 * **Parameters are additions, never overrides.** The one-off scripts the Jobs
 * story promises — restore from snapshot X, reindex since a date — take their
 * argument as `env`, appended to the run's container after the template's
 * own. A name the placed workload already delivers is refused: every config
 * variable is a sealed reference (§10), and letting a run shadow one would put
 * the value inline in a Job spec, which is the asymmetry §10 exists to avoid.
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

/**
 * The longest value one parameter may carry. A parameter is a snapshot name
 * or a date, and a Job spec is not the place for a document.
 */
export const RUN_PARAMETER_LIMIT = 4_096;

export const runComponentInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /**
     * Plain variables for this run only. The names are checked in the handler
     * rather than here: a record's key issue surfaces as "Invalid key in
     * record", and the person who typed it deserves the sentence config gives.
     */
    env: z.record(z.string(), z.string().max(RUN_PARAMETER_LIMIT)).optional(),
  })
  .strict();

export type RunComponentInput = z.infer<typeof runComponentInput>;

export interface RunComponentResult {
  /** The run the backend started, in its own name for it. */
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
  // The kind is checked here as well as by the adapter, because the two
  // refusals are different sentences: this one is about the Component a person
  // is looking at, and the adapter's is about the object a ref names.
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
    // The newest Deploy that placed something. An older ref may name a
    // workload a re-place has since moved, and running the one that is serving
    // is the only reading of "run it now" that matches what the screen shows.
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
  // What the placed release already delivers, read off the document it was
  // placed from rather than the config rows: the rows may have moved since,
  // and the workload the run is made from is the one this document describes.
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

  // §17: the adapter refuses in a sentence and throws on a fault, so the two
  // are reported as two things. A refusal is the operator's to act on — the
  // wrong backend, a workload that is gone — and a fault is the far side's.
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
