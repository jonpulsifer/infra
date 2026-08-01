import { z } from 'zod';
import type { Blame, FailureReason } from '../../adapters/deploy/contract.ts';
import type {
  BuildView,
  ChecklistItem,
  DeployPhase,
  DeployView,
  Diagnosis,
  LogFidelity,
  LogLine,
} from '../../web/model.ts';
import { type Command, failed, ok } from '../types.ts';

export const getDeployDetailInput = z.object({
  id: z.union([z.number(), z.string()]),
});
export type GetDeployDetailInput = z.infer<typeof getDeployDetailInput>;

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
      target: true,
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

  let diagnosis: Diagnosis | null = null;
  if (deploy.phase === 'FAILED' && deploy.reason) {
    diagnosis = {
      reason: deploy.reason as FailureReason,
      blame: (deploy.blame ?? null) as Blame | null,
      detail: deploy.detail ?? 'Deploy failed',
      evidence:
        typeof deploy.debug === 'string'
          ? deploy.debug
          : JSON.stringify(deploy.debug ?? {}),
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

  const buildLogEvents = await context.db.query.attemptEvents.findMany({
    where: (events, { eq }) => eq(events.buildId, deploy.build.id),
    orderBy: (events, { asc }) => [asc(events.id)],
  });

  const buildLogs: LogLine[] = buildLogEvents
    .filter((e) => e.eventType === 'log' && e.line)
    .map((e) => ({
      text: e.line!,
      tone: e.reason ? ('error' as const) : undefined,
    }));
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
  if (deployLogs.length === 0 && diagnosis?.evidence) {
    deployLogs.push(
      ...diagnosis.evidence.split('\n').map((text) => ({
        text,
        tone: 'error' as const,
      })),
    );
  }

  const buildSteps: ChecklistItem[] = buildLogEvents
    .filter((e) => e.resource)
    .map((e) => ({
      name: e.resource!,
      status: e.reason ? 'failed' : 'done',
      detail: e.line ?? undefined,
    }));

  const buildStatus =
    deploy.build.status === 'SUCCEEDED'
      ? 'done'
      : deploy.build.status === 'FAILED'
        ? 'failed'
        : 'running';

  let duration: string | undefined;
  if (deploy.build.createdAt && deploy.createdAt) {
    const elapsedSeconds = Math.max(
      1,
      Math.round(
        (deploy.createdAt.getTime() - deploy.build.createdAt.getTime()) / 1000,
      ),
    );
    duration = `${elapsedSeconds}s`;
  }

  const build: BuildView = {
    status: buildStatus,
    duration,
    fidelity: (deploy.build.logFidelity ?? 'LIVE_TEXT') as LogFidelity,
    steps:
      buildSteps.length > 0
        ? buildSteps
        : [{ name: 'build artifact', status: buildStatus }],
    log: buildLogs.length > 0 ? buildLogs : null,
    runner: deploy.build.runner ?? 'hosted runner',
  };

  let phaseWord = 'Building';
  if (deploy.phase === 'LIVE') phaseWord = 'Live';
  else if (deploy.phase === 'FAILED') {
    phaseWord =
      deploy.build.status === 'FAILED' ? 'Build failed' : 'Deploy failed';
  } else if (deploy.phase === 'APPLYING') phaseWord = 'Applying';

  let headline = `Deployed to ${deploy.target.name}`;
  if (deploy.phase === 'LIVE') {
    headline = `Reconciled on ${deploy.target.name}`;
  } else if (deploy.phase === 'FAILED') {
    headline = deploy.detail ?? 'Deploy failed';
  } else {
    headline = `Deploying on ${deploy.target.name}`;
  }

  const view: DeployView = {
    id: deploy.id,
    buildId: deploy.build.id,
    componentId: deploy.component.id,
    targetId: deploy.target.id,
    appId: deploy.component.app.id,
    app: deploy.component.app.name,
    component: deploy.component.name,
    target: deploy.target.name,
    commit: deploy.build.commit,
    phase: deploy.phase as DeployPhase,
    phaseWord,
    headline,
    url: deploy.url ?? deploy.component.app.vanityDomain ?? '',
    urlLive: deploy.phase === 'LIVE',
    previousReleaseServing,
    diagnosis,
    resources,
    build,
    deployLog: deployLogs.length > 0 ? deployLogs : null,
  };

  return ok({ deploy: view });
};
