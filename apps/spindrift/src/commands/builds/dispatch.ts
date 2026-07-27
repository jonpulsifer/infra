/**
 * `dispatchBuild` — run one source through one build route (§4).
 *
 * §4: "**Build is always separate from Deploy**... a build records an artifact
 * rather than deploying one, so a late-finishing older build moves nothing.
 * There is no `SUPERSEDED` verdict to explain."
 *
 * That sentence is the design of this file. What it does when a build succeeds is
 * write a digest onto a Build row — and nothing else. It does not touch the
 * desired row, it does not create a Deploy, and it does not compare itself
 * against any other Build. **A build that finishes last is a build that finishes
 * last**, and the reason that costs nothing is that finishing has no effect on
 * what is live. Making a Deploy is a separate act somebody takes deliberately.
 *
 * Two more §4 terms are structural here rather than documented:
 *
 * - **The bundle digest is a parameter on every route.** It comes off the Build
 *   row and goes into {@link BuildSource}, which requires it, so a route cannot
 *   be handed a source without one (§16's join).
 * - **Logs are read, not pushed.** The adapter yields events and this loop writes
 *   them to the attempt log; nothing is exposed for a builder to post back to.
 *   Whatever fidelity the route declared is what lands, and the route's name and
 *   fidelity are recorded on the Build so an operator can see why a log is thin
 *   rather than reading it as a bug.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { BuildSource, BuildSpec } from '../../adapters/build/contract.ts';
import { apps, builds, components } from '../../db/schema.ts';
import { recordBuildEvent } from '../../domain/attempt-log.ts';
import { DEFAULT_PLATFORM } from '../../domain/placement.ts';
import { buildOriginOf, type Source } from '../../domain/source.ts';
import { type Command, failed, ok } from '../types.ts';

export const dispatchBuildInput = z
  .object({
    /** The Build row to run. It already carries the source and the shape. */
    buildId: z.number().int().positive(),
    /**
     * Which route to run it on. §4 makes the set of routes an installation's
     * configuration rather than a closed vocabulary, so this is a name core does
     * not interpret — it hands it to the registry and reports what comes back.
     */
    route: z.string().trim().min(1),
  })
  .strict();

export type DispatchBuildInput = z.infer<typeof dispatchBuildInput>;

export interface DispatchBuildResult {
  readonly buildId: number;
  readonly status: 'SUCCEEDED' | 'FAILED';
  /** Set when the build succeeded. */
  readonly artifactDigest: string | null;
  /** The route that ran, as recorded on the Build (§4). */
  readonly runner: string;
}

export const dispatchBuild: Command<
  DispatchBuildInput,
  DispatchBuildResult
> = async (input, context) => {
  const [build] = await context.db
    .select()
    .from(builds)
    .where(eq(builds.id, input.buildId));
  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build with id ${input.buildId}`);
  }

  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, build.componentId));
  if (component === undefined) {
    return failed(
      'NOT_FOUND',
      `Build ${build.id} names a Component that no longer exists`,
    );
  }

  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, component.appId));
  if (app === undefined) {
    return failed(
      'NOT_FOUND',
      `Component ${component.id} names an App that no longer exists`,
    );
  }

  // §4's supplied artifact: an archive of finished output already *is* the
  // artifact, digested over the bundle core staged. There is no route to run and
  // running one would produce a second digest over the same bytes.
  if (build.status === 'SUCCEEDED' && build.artifactDigest !== null) {
    return ok({
      buildId: build.id,
      status: 'SUCCEEDED' as const,
      artifactDigest: build.artifactDigest,
      runner: build.runner ?? 'supplied',
    });
  }

  if (build.bundleDigest === null) {
    // §16: "the bundle digest must be a build parameter on every route, or the
    // correlation between a source receipt and a provenance document has no
    // join." A Build without one cannot be dispatched at all.
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle, so no route can be given one`,
    );
  }

  const adapter = context.adapters.build(input.route);
  if (adapter === null) {
    return failed(
      'NOT_FOUND',
      `this installation has no build route named ${input.route}`,
    );
  }

  const source: Source =
    app.sourceKind === 'repo'
      ? {
          kind: 'repo',
          url: app.sourceRepoUrl ?? '',
          commit: build.commit,
          subpath: app.sourceRepoSubpath ?? '.',
        }
      : {
          kind: 'archive',
          digest: build.bundleDigest,
          location: build.artifactRefs?.[0] ?? '',
          contents: 'source',
          subpath: app.sourceRepoSubpath ?? '.',
        };

  const buildSource: BuildSource = {
    bundleDigest: build.bundleDigest,
    origin: buildOriginOf(source),
  };

  const spec: BuildSpec = {
    artifactType: build.artifactType,
    kind: component.kind,
    platform: DEFAULT_PLATFORM,
    /**
     * §16 names one registry per installation — "every artifact is pushed to and
     * pulled from" it — and a Build is keyed on a *shape*, not on a Target (§2),
     * so there is no Target here to read a reachable registry off. That is the
     * right way round: whether a Target can reach the registry is a placement
     * filter (§3's `reachableRegistries`), applied before the build, not a
     * choice the build makes. An adapter never picks its own destination (§4).
     */
    destination: context.manifest.supplyChain.registry,
    buildArgs: {},
  };

  const attempt = {
    appId: app.id,
    componentId: component.id,
    buildId: build.id,
  };

  await context.db
    .update(builds)
    .set({
      status: 'RUNNING',
      runner: adapter.name,
      logFidelity: adapter.logFidelity,
    })
    .where(eq(builds.id, build.id));

  const stream = adapter.build(buildSource, spec);
  let next = await stream.next();
  while (!next.done) {
    const event = next.value;
    // §6's one attempt-scoped log: build events and deploy events land on the
    // same stream for the same attempt, so the UI subscribes once.
    await recordBuildEvent(
      context.db,
      attempt,
      event.type === 'log'
        ? {
            type: 'log',
            line: event.line,
            ...(event.step ? { resource: event.step } : {}),
          }
        : { type: 'status', phase: event.state, resource: event.step },
    );
    next = await stream.next();
  }
  const result = next.value;

  if (result.status === 'FAILED') {
    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: result.reason,
    });
    await context.db
      .update(builds)
      .set({ status: 'FAILED' })
      .where(eq(builds.id, build.id));
    return ok({
      buildId: build.id,
      status: 'FAILED' as const,
      artifactDigest: null,
      runner: adapter.name,
    });
  }

  await recordBuildEvent(context.db, attempt, {
    type: 'status',
    phase: 'SUCCEEDED',
  });

  await context.db
    .update(builds)
    .set({
      status: 'SUCCEEDED',
      artifactDigest: result.artifact.digest,
      artifactRefs: [...result.artifact.refs],
      baseDigest: result.baseDigest,
      provenance: result.provenance,
    })
    .where(eq(builds.id, build.id));

  return ok({
    buildId: build.id,
    status: 'SUCCEEDED' as const,
    artifactDigest: result.artifact.digest,
    runner: adapter.name,
  });
};
