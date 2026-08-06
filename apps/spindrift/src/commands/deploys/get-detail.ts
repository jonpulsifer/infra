import { z } from 'zod';
import type { Blame, FailureReason } from '../../adapters/deploy/contract.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { targetRowLabel } from '../../domain/target.ts';
import type {
  ChecklistItem,
  DeployPhase,
  DeployView,
  Diagnosis,
  LogLine,
} from '../../web/model.ts';
import { buildViewOf, sourceViewOf } from '../builds/view.ts';
import { type Command, failed, ok } from '../types.ts';

export const getDeployDetailInput = z.object({
  id: z.union([z.number(), z.string()]),
});
export type GetDeployDetailInput = z.infer<typeof getDeployDetailInput>;

/**
 * §6's raw `debug` payload as a screen can read it, or `null` where core
 * recorded nothing.
 *
 * `debug` is nullable and usually null: a Deploy that goes red on something
 * core decided for itself — an artifact with no address to pull it by — never
 * reaches a platform that could hand back events to persist. Serialising that
 * absence yields `"{}"`, which is not evidence, is not what any runner emitted,
 * and is truthy enough to be mistaken for both by everything downstream. So
 * nothing is reported as nothing, and the views that already know how to say
 * "there is nothing here" get to say it.
 */
function evidenceOf(debug: unknown): string | null {
  if (debug === null || debug === undefined) return null;
  if (typeof debug === 'string') return debug.trim() === '' ? null : debug;
  const serialised = JSON.stringify(debug);
  // An empty document is the same absence wearing braces — a red Deploy whose
  // adapter opened a payload and put nothing in it saw nothing either.
  if (serialised === undefined || serialised === '{}' || serialised === '[]') {
    return null;
  }
  return serialised;
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

  // The release before this one here, whatever it did. `previousLiveDeploy`
  // above answers a different question — "is anything still serving" — and a
  // reader stepping back through the history wants the row that came before,
  // including the one that failed.
  const previousDeploy = await context.db.query.deploys.findFirst({
    where: (deploys, { eq, and, lt }) =>
      and(
        eq(deploys.componentId, deploy.componentId),
        eq(deploys.targetId, deploy.targetId),
        lt(deploys.id, deploy.id),
      ),
    orderBy: (deploys, { desc }) => [desc(deploys.id)],
  });

  // §6's desired row is the only thing that knows which release *should* be
  // running: a LIVE Deploy that a newer intent superseded is still LIVE.
  const desired = await context.db.query.componentTargetDesired.findFirst({
    where: (rows, { eq, and }) =>
      and(
        eq(rows.componentId, deploy.componentId),
        eq(rows.targetId, deploy.targetId),
      ),
  });

  let diagnosis: Diagnosis | null = null;
  if (deploy.phase === 'FAILED' && deploy.reason) {
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
  // Evidence stands in for a deploy log only when there is evidence. Where
  // there is none, `deployLog` stays null and the card renders its own
  // `LIVE_STATUS` notice — the true sentence about a controller that reports
  // status without text.
  if (deployLogs.length === 0 && diagnosis?.evidence) {
    deployLogs.push(
      ...diagnosis.evidence.split('\n').map((text) => ({
        text,
        tone: 'error' as const,
      })),
    );
  }

  // "Building" is only honest while something is building. A release whose
  // artifact was uploaded rather than built (§4) is releasing, not building,
  // and a screen that said otherwise would name a step that never ran.
  let phaseWord = build === null ? 'Releasing' : 'Building';
  if (deploy.phase === 'LIVE') phaseWord = 'Live';
  else if (deploy.phase === 'FAILED') {
    // The deploy's own verdict outranks the Build row, and the order is the
    // fix. A Deploy that recorded a reason failed *here* — it was applied, the
    // platform answered, and §6 persisted what it said. Reading the Build
    // first meant that reason lost to a FAILED Build row, which is exactly the
    // pairing supply-chain admission produces: the runner pushed an image, the
    // artifact was refused, and the screen blamed a build that had already
    // done its job. A build is only the failure when nothing after it spoke.
    phaseWord =
      deploy.reason === null && deploy.build.status === 'FAILED'
        ? 'Build failed'
        : 'Deploy failed';
  } else if (deploy.phase === 'APPLYING') phaseWord = 'Applying';

  let headline = `Deployed to ${targetRowLabel(deploy.target)}`;
  if (deploy.phase === 'LIVE') {
    headline = `Reconciled on ${targetRowLabel(deploy.target)}`;
  } else if (deploy.phase === 'FAILED') {
    headline = deploy.detail ?? 'Deploy failed';
  } else {
    headline = `Deploying on ${targetRowLabel(deploy.target)}`;
  }

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
    url: deploy.url ?? deploy.component.app.vanityDomain ?? '',
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
    resources,
    source,
    build,
    deployLog: deployLogs.length > 0 ? deployLogs : null,
    when: elapsedSince(deploy.createdAt, context.clock.now()),
    at: deploy.createdAt.toISOString(),
    current: desired?.desiredDeployId === deploy.id,
    configVersion: deploy.configVersion,
    artifactDigest: deploy.build.artifactDigest,
    previousDeployId: previousDeploy?.id ?? null,
    // The same comparison `rollbackDeploy` makes under the lock. It can still
    // refuse for a reason this projection cannot see — a disconnected Target, a
    // signature that stopped verifying — and that refusal is a sentence the
    // operator reads rather than something to pre-empt by hiding the button.
    rollbackable:
      desired?.desiredDeployId !== deploy.id &&
      desired?.desiredBuildId != null &&
      deploy.buildId < desired.desiredBuildId &&
      deploy.build.artifactDigest !== null,
  };

  return ok({ deploy: view });
};
