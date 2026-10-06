import { and, desc, eq, lt, min } from 'drizzle-orm';
import { z } from 'zod';
import type { Blame, FailureReason } from '../../adapters/deploy/contract.ts';
import { attemptEvents, deploys } from '../../db/schema.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { buildViewOf, sourceViewOf } from '../builds/view.ts';
import { principalLabels } from '../principals.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import {
  type ChecklistItem,
  type DeployPhase,
  type DeployView,
  type Diagnosis,
  type ExpectedDuration,
  isInFlight,
  type LogLine,
} from '../views.ts';

export const getDeployDetailInput = z.object({
  id: z.union([z.number(), z.string()]),
});
export type GetDeployDetailInput = z.infer<typeof getDeployDetailInput>;

/**
 * The raw `debug` payload as text, or `null` when core recorded nothing. An
 * empty document is absence too, not evidence.
 */
function evidenceOf(debug: unknown): string | null {
  if (debug === null || debug === undefined) return null;
  if (typeof debug === 'string') return debug.trim() === '' ? null : debug;
  const serialised = JSON.stringify(debug);
  if (serialised === undefined || serialised === '{}' || serialised === '[]') {
    return null;
  }
  return serialised;
}

/** How many prior releases the estimate reads. */
const HISTORY = 100;
/** Below this, a percentile is a guess. */
const MIN_SAMPLES = 3;

/**
 * The p90 of created-to-LIVE over earlier releases of this Component@Target.
 * LIVE is the status event on the attempt log; no `deploys` column records it.
 */
async function expectedDurationOf(
  context: CommandContext,
  subject: { id: number; componentId: string; targetId: string },
): Promise<ExpectedDuration | undefined> {
  const rows = await context.db
    .select({
      startedAt: deploys.createdAt,
      liveAt: min(attemptEvents.createdAt),
    })
    .from(deploys)
    .innerJoin(
      attemptEvents,
      and(
        eq(attemptEvents.deployId, deploys.id),
        eq(attemptEvents.eventType, 'status'),
        eq(attemptEvents.phase, 'LIVE'),
      ),
    )
    .where(
      and(
        eq(deploys.componentId, subject.componentId),
        eq(deploys.targetId, subject.targetId),
        lt(deploys.id, subject.id),
      ),
    )
    .groupBy(deploys.id)
    .orderBy(desc(deploys.id))
    .limit(HISTORY);

  const durations = rows
    .map((row) => new Date(row.liveAt!).getTime() - row.startedAt.getTime())
    .filter((ms) => ms >= 0)
    .sort((a, b) => a - b);
  if (durations.length < MIN_SAMPLES) return undefined;
  // Nearest rank, which never invents a value between two samples.
  const p90Ms = durations[Math.ceil(durations.length * 0.9) - 1]!;
  return { p90Ms, samples: durations.length };
}

export const getDeployDetail: Command<
  GetDeployDetailInput,
  { deploy: DeployView }
> = async (input, context) => {
  const numericId =
    typeof input.id === 'number' ? input.id : Number.parseInt(input.id, 10);

  if (Number.isNaN(numericId)) {
    return failed('NOT_FOUND', `Deploy '${input.id}' not found`);
  }

  const deploy = await context.db.query.deploys.findFirst({
    where: (deploys, { eq }) => eq(deploys.id, numericId),
    with: {
      component: {
        with: {
          app: true,
        },
      },
      target: { with: { vessel: true } },
      build: true,
    },
  });

  if (!deploy) {
    return failed('NOT_FOUND', `Deploy '${numericId}' not found`);
  }

  const previousLiveDeploy = await context.db.query.deploys.findFirst({
    where: (deploys, { eq, and, lt }) =>
      and(
        eq(deploys.componentId, deploy.componentId),
        eq(deploys.targetId, deploy.targetId),
        lt(deploys.id, deploy.id),
        eq(deploys.phase, 'LIVE'),
      ),
    orderBy: (deploys, { desc }) => [desc(deploys.id)],
  });

  const previousReleaseServing = Boolean(
    previousLiveDeploy && deploy.phase !== 'LIVE',
  );

  // The release just before this one, failed or not.
  const previousDeploy = await context.db.query.deploys.findFirst({
    where: (deploys, { eq, and, lt }) =>
      and(
        eq(deploys.componentId, deploy.componentId),
        eq(deploys.targetId, deploy.targetId),
        lt(deploys.id, deploy.id),
      ),
    orderBy: (deploys, { desc }) => [desc(deploys.id)],
  });

  // Only the desired row knows which release should run: a superseded LIVE
  // Deploy is still LIVE.
  const desired = await context.db.query.componentTargetDesired.findFirst({
    where: (rows, { eq, and }) =>
      and(
        eq(rows.componentId, deploy.componentId),
        eq(rows.targetId, deploy.targetId),
      ),
  });

  // The soak writes a faulty release's diagnosis like a red attempt's.
  let diagnosis: Diagnosis | null = null;
  if (
    (deploy.phase === 'FAILED' || deploy.faultyAt !== null) &&
    deploy.reason
  ) {
    diagnosis = {
      reason: deploy.reason as FailureReason,
      blame: (deploy.blame ?? null) as Blame | null,
      detail: deploy.detail ?? 'Deploy failed',
      evidence: evidenceOf(deploy.debug),
    };
  }

  const resourceEvents = await context.db.query.attemptEvents.findMany({
    where: (events, { eq, and, isNotNull }) =>
      and(eq(events.deployId, deploy.id), isNotNull(events.resource)),
  });

  const resources: ChecklistItem[] = resourceEvents.map((e) => ({
    name: e.resource!,
    status: e.reason
      ? 'failed'
      : e.phase === 'LIVE' || e.phase === 'done'
        ? 'done'
        : 'waiting',
    detail: e.line ?? undefined,
  }));

  if (resources.length === 0) {
    resources.push(
      {
        name: `Deployment/${deploy.component.name}`,
        status:
          deploy.phase === 'LIVE'
            ? 'done'
            : deploy.phase === 'FAILED'
              ? 'failed'
              : 'waiting',
      },
      {
        name: `Service/${deploy.component.name}`,
        status: deploy.phase === 'LIVE' ? 'done' : 'waiting',
      },
    );
  }

  const { view: build } = await buildViewOf(context, deploy.build);
  const source = sourceViewOf(deploy.component.app, deploy.build);
  const expectedDuration = await expectedDurationOf(context, deploy);

  const deployLogEvents = await context.db.query.attemptEvents.findMany({
    where: (events, { eq }) => eq(events.deployId, deploy.id),
    orderBy: (events, { asc }) => [asc(events.id)],
  });
  const deployLogs: LogLine[] = deployLogEvents
    .filter((event) => event.eventType === 'log' && event.line)
    .map((event) => ({
      text: event.line!,
      tone: event.reason ? ('error' as const) : undefined,
    }));
  // No log and no evidence leaves deployLog null; the card shows its own
  // notice.
  if (deployLogs.length === 0 && diagnosis?.evidence) {
    deployLogs.push(
      ...diagnosis.evidence.split('\n').map((text) => ({
        text,
        tone: 'error' as const,
      })),
    );
  }

  // An uploaded artifact was never built, so its release is not "Building".
  let phaseWord = build === null ? 'Releasing' : 'Building';
  // Faulty: the rollout landed and the platform has since reported it failed.
  if (deploy.phase === 'LIVE') {
    phaseWord = deploy.faultyAt === null ? 'Live' : 'Faulty';
  } else if (deploy.phase === 'FAILED') {
    // A recorded reason means the Deploy itself failed, even beside a FAILED
    // Build: admission can refuse an artifact the runner pushed.
    phaseWord =
      deploy.reason === null && deploy.build.status === 'FAILED'
        ? 'Build failed'
        : 'Deploy failed';
  } else if (deploy.phase === 'APPLYING') phaseWord = 'Applying';

  let headline = `Deployed to ${targetRowLabel(deploy.target)}`;
  if (deploy.phase === 'LIVE') {
    headline =
      deploy.faultyAt === null
        ? `Reconciled on ${targetRowLabel(deploy.target)}`
        : (deploy.detail ?? 'Failed after readiness');
  } else if (deploy.phase === 'FAILED') {
    headline = deploy.detail ?? 'Deploy failed';
  } else {
    headline = `Deploying on ${targetRowLabel(deploy.target)}`;
  }

  const requestedBy = (await principalLabels(context.db, [deploy.requestedBy]))(
    deploy.requestedBy,
  );

  const view: DeployView = {
    id: deploy.id,
    buildId: deploy.build.id,
    componentId: deploy.component.id,
    targetId: deploy.target.id,
    appId: deploy.component.app.id,
    app: deploy.component.app.name,
    component: deploy.component.name,
    target: targetRowLabel(deploy.target),
    commit: deploy.build.commit,
    phase: deploy.phase as DeployPhase,
    phaseWord,
    headline,
    // Only what this Deploy published: vanityDomain is a label, not an address.
    url: deploy.url ?? '',
    urlLive: deploy.phase === 'LIVE',
    previousReleaseServing,
    diagnosis,
    drift:
      deploy.driftedAt === null
        ? null
        : {
            since: elapsedSince(deploy.driftedAt, context.clock.now()),
            at: deploy.driftedAt.toISOString(),
            observedDigest: deploy.observedDigest,
            detail: deploy.driftDetail,
          },
    ...(deploy.faultyAt === null
      ? {}
      : { faultyAt: deploy.faultyAt.toISOString() }),
    // Only while in flight; a settled row's detail names who cancelled it.
    ...(deploy.cancelRequestedBy === null || !isInFlight(deploy.phase)
      ? {}
      : { cancelRequestedBy: deploy.cancelRequestedBy }),
    resources,
    source,
    build,
    deployLog: deployLogs.length > 0 ? deployLogs : null,
    when: elapsedSince(deploy.createdAt, context.clock.now()),
    at: deploy.createdAt.toISOString(),
    current: desired?.desiredDeployId === deploy.id,
    configVersion: deploy.configVersion,
    artifactDigest: deploy.build.artifactDigest,
    ...(requestedBy === undefined ? {} : { requestedBy }),
    previousDeployId: previousDeploy?.id ?? null,
    // The comparison rollbackDeploy makes under the lock. Its other refusals,
    // such as a disconnected Target, reach the operator as its sentence.
    rollbackable:
      desired?.desiredDeployId !== deploy.id &&
      desired?.desiredBuildId != null &&
      deploy.buildId < desired.desiredBuildId &&
      deploy.build.artifactDigest !== null,
    ...(expectedDuration === undefined ? {} : { expectedDuration }),
  };

  return ok({ deploy: view });
};
