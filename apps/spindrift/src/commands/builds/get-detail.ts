/**
 * `getBuildDetail` — the attempt screen for a Build that has no Deploy yet.
 *
 * §4: "a build records an artifact rather than deploying one", so pressing
 * Deploy on an App with nothing deployable starts a Build and writes no intent
 * (`deployApp` returns `deployId: null`). Before this command existed there was
 * nowhere for that press to land: the operator stayed on the workspace and the
 * act they had just taken had no screen. A Build is an attempt with a durable
 * id and a live event stream, which is everything an attempt screen needs — the
 * only thing it lacks is the intent row, and that absence is what
 * {@link DeployView.id} being `null` says.
 *
 * The result also carries {@link GetBuildDetailResult.deployId}. A Build that
 * has since been deployed has a better screen than this one, and the client
 * follows that id rather than leaving a reader on an attempt page that has been
 * superseded by a release.
 */
import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import type { DeployPhase, DeployView } from '../../web/model.ts';
import { type Command, failed, ok } from '../types.ts';
import { buildViewOf, sourceViewOf } from './view.ts';

export const getBuildDetailInput = z.object({
  id: z.union([z.number(), z.string()]),
});
export type GetBuildDetailInput = z.infer<typeof getBuildDetailInput>;

export interface GetBuildDetailResult {
  /** The Build as an attempt, with `id: null` — no intent has been written. */
  readonly attempt: DeployView;
  /**
   * The newest Deploy naming this Build, once one exists.
   *
   * Not folded into `attempt.id`: that field says what *this* view is, and this
   * view is a Build. A caller that wants the release goes and reads it.
   */
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
          desiredTargets: { limit: 1, with: { target: true } },
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
  const target = build.component.desiredTargets[0]?.target ?? null;

  // Where this Build is headed, resolved the same way `deployApp` resolves it:
  // the desired row is what says which Target a Component belongs on before any
  // intent has named one.
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
    target: target?.name ?? 'not placed',
    commit: build.commit,
    phase: PHASE[build.status],
    phaseWord: buildView === null ? 'Extracted' : PHASE_WORD[build.status],
    headline: headlineFor(
      build.status,
      buildView?.runner ?? null,
      target?.name ?? null,
    ),
    url: build.component.app.vanityDomain ?? '',
    // A Build never serves anything: §6's exposure is only ever changed by an
    // intent, and there is no intent here.
    urlLive: false,
    previousReleaseServing: previousLive !== null,
    // §6 persists a diagnosis on a Deploy going red. A Build that failed says
    // so in its own log, and inventing a `Diagnosis` here would put a reason
    // from the closed deploy-failure set on something that never deployed.
    diagnosis: null,
    // Nothing has been placed, so there is nothing to check off. An empty list
    // renders no section at all, which is the honest shape.
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
    // There is no intent to roll back to. Rollback names a Deploy's Build, and
    // this attempt has no Deploy.
    rollbackable: false,
  };

  return ok({ attempt, deployId: build.deploys[0]?.id ?? null });
};

/**
 * A Build's status in the phase vocabulary the screen renders.
 *
 * The mapping is a projection, not a claim that the two are the same thing:
 * `WAITING` for a succeeded Build says exactly what is true — the artifact
 * exists and nothing has placed it yet.
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

/**
 * The sentence under the phase.
 *
 * A `null` runner is §4's supplied artifact: nothing ran, so "built" is the
 * wrong verb for it and the headline says what did happen instead.
 */
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
