/** One Build shown as an attempt, whether placed or not. */
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';
import type { DeployPhase, DeployView } from '../views.ts';
import { buildViewOf, sourceViewOf } from './view.ts';

export const getBuildDetailInput = z.object({
  id: z.union([z.number(), z.string()]),
});
export type GetBuildDetailInput = z.infer<typeof getBuildDetailInput>;

export interface GetBuildDetailResult {
  /** `id` is `null` because a Build is not a Deploy. */
  readonly attempt: DeployView;
  /** The newest Deploy that used this Build, or `null`. */
  readonly deployId: number | null;
}

export const getBuildDetail: Command<
  GetBuildDetailInput,
  GetBuildDetailResult
> = async (input, context) => {
  const numericId =
    typeof input.id === 'number' ? input.id : Number.parseInt(input.id, 10);

  if (Number.isNaN(numericId)) {
    return failed('NOT_FOUND', `Build '${input.id}' not found`);
  }

  const build = await context.db.query.builds.findFirst({
    where: (builds, { eq }) => eq(builds.id, numericId),
    with: {
      component: {
        with: {
          app: true,
          // The placement of record, which `deployApp` acts on.
          placedTarget: { with: { vessel: true } },
        },
      },
      deploys: {
        orderBy: (deploys, { desc }) => [desc(deploys.id)],
        limit: 1,
      },
    },
  });

  if (!build) {
    return failed('NOT_FOUND', `Build '${numericId}' not found`);
  }

  const { view: buildView } = await buildViewOf(context, build);
  const target = build.component.placedTarget;

  // Where this Build is headed: the placement of record, as `deployApp` resolves it.
  const previousLive = target
    ? await context.db.query.deploys.findFirst({
        where: (deploys, { eq, and }) =>
          and(
            eq(deploys.componentId, build.componentId),
            eq(deploys.targetId, target.id),
            eq(deploys.phase, 'LIVE'),
          ),
        orderBy: (deploys, { desc }) => [desc(deploys.id)],
      })
    : null;

  const attempt: DeployView = {
    id: null,
    buildId: build.id,
    componentId: build.component.id,
    targetId: target?.id ?? '',
    appId: build.component.app.id,
    app: build.component.app.name,
    component: build.component.name,
    target: targetRowLabel(target),
    commit: build.commit,
    phase: PHASE[build.status],
    phaseWord: buildView === null ? 'Extracted' : PHASE_WORD[build.status],
    headline: headlineFor(
      build.status,
      buildView?.runner ?? null,
      target === null ? null : targetRowLabel(target),
    ),
    // A Build serves nothing, so it has no address.
    url: '',
    urlLive: false,
    previousReleaseServing: previousLive !== null,
    // A failed Build says why in its own log. A Diagnosis belongs to a Deploy.
    diagnosis: null,
    // Drift needs a LIVE release, and a Build has placed nothing.
    drift: null,
    // An empty list renders no section.
    resources: [],
    source: sourceViewOf(build.component.app, build),
    build: buildView,
    deployLog: null,
    when: elapsedSince(build.createdAt, context.clock.now()),
    at: build.createdAt.toISOString(),
    current: false,
    configVersion: null,
    artifactDigest: build.artifactDigest,
    previousDeployId: previousLive?.id ?? null,
    // Rollback names a Deploy's Build, and this attempt has no Deploy.
    rollbackable: false,
  };

  return ok({ attempt, deployId: build.deploys[0]?.id ?? null });
};

/**
 * A Build's status in the phase words the screen renders. A succeeded Build is
 * `WAITING`: the artifact exists and nothing has placed it.
 */
const PHASE = {
  PENDING: 'PENDING',
  RUNNING: 'APPLYING',
  SUCCEEDED: 'WAITING',
  FAILED: 'FAILED',
} as const satisfies Record<string, DeployPhase>;

const PHASE_WORD = {
  PENDING: 'Queued',
  RUNNING: 'Building',
  SUCCEEDED: 'Built',
  FAILED: 'Build failed',
} as const;

/** A `null` runner is a supplied artifact: nothing ran, so nothing was built. */
function headlineFor(
  status: keyof typeof PHASE,
  runner: string | null,
  target: string | null,
): string {
  const ready =
    target === null
      ? 'this Component has no Target placement yet'
      : `ready to deploy to ${target}`;

  switch (status) {
    case 'PENDING':
      return 'Queued — waiting for a runner to claim it';
    case 'RUNNING':
      return `Building on ${runner ?? 'a runner'}`;
    case 'SUCCEEDED':
      return runner === null
        ? `Uploaded output recorded as-is — ${ready}`
        : `Built — ${ready}`;
    case 'FAILED':
      return 'Build failed — nothing was placed';
  }
}
