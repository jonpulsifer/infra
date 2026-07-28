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
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type {
  BuildAdapter,
  BuildSource,
  BuildSpec,
} from '../../adapters/build/contract.ts';
import { apps, builds, components, targets } from '../../db/schema.ts';
import { recordBuildEvent } from '../../domain/attempt-log.ts';
import {
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
} from '../../domain/build-route.ts';
import { DEFAULT_PLATFORM } from '../../domain/placement.ts';
import { buildOriginOf, type Source } from '../../domain/source.ts';
import { isBuildTimeConfig, readBuildArgs } from '../config/build-args.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

/**
 * §4's per-App build limit.
 *
 * A constant rather than a manifest value: it exists to stop one App's push
 * loop from taking every runner an installation has, and the number that does
 * that is a property of "how many is obviously too many" rather than of any
 * particular installation. It becomes configuration the first time an operator
 * has a reason to disagree with it.
 */
export const CONCURRENT_BUILDS_PER_APP = 3;

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
    /**
     * The Target this build's placement resolved to, where the artifact's
     * contents depend on it.
     *
     * Only a `website` needs it, and only because §10 scopes configuration to
     * (Component, Target) while §2 keys a Build on (Component, commit,
     * target-shape). For everything else configuration is delivered at runtime
     * and the shape is the whole of what a build depends on, so this is absent
     * and nothing reads it.
     *
     * **The known limit, stated rather than worked around**: two Targets of the
     * same shape with different website build arguments want two artifacts and
     * the Build key cannot tell them apart. The second dispatch collides on the
     * unique key rather than silently serving the first one's values.
     */
    placementTargetId: z.uuid().optional(),
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

/**
 * Why this Target will not take a build from this route, or `null`.
 *
 * §16: "each Target has a minimum build level defaulting to L2 plus an ordered
 * list of build routes: **the level is a threshold, then admin rank wins**."
 * The rank half belongs to whoever *chooses* a route; by the time a route has
 * been named the only question left is the threshold, which is the Target's.
 *
 * Checked here rather than left to admission because the failure is cheaper and
 * far more legible now: refusing to start costs nothing, while an artifact
 * built below a Target's minimum is a green build followed by a deploy that a
 * policy engine rejects for reasons nobody reading the build log can see.
 *
 * A dispatch that names no placement is not checked, because there is no Target
 * whose threshold could apply — which is also why a build for a shape rather
 * than for a Target is legitimate (§2).
 */
interface TargetBuildPolicy {
  readonly name: string;
  readonly minimumLevel: 1 | 2 | 3;
}

async function targetBuildPolicy(
  context: CommandContext,
  targetId: string | undefined,
): Promise<TargetBuildPolicy | null> {
  if (targetId === undefined) return null;
  const [target] = await context.db
    .select({ name: targets.name, minBuildLevel: targets.minBuildLevel })
    .from(targets)
    .where(eq(targets.id, targetId));
  if (target === undefined) return null;
  return {
    name: target.name,
    minimumLevel: (target.minBuildLevel ?? DEFAULT_MINIMUM_BUILD_LEVEL) as
      | 1
      | 2
      | 3,
  };
}

function routeRefusedByTarget(
  policy: TargetBuildPolicy | null,
  adapter: BuildAdapter,
): string | null {
  if (policy === null) return null;
  const [candidate] = buildRouteCandidates(
    [{ name: adapter.name, level: adapter.buildLevel }],
    { minimumLevel: policy.minimumLevel },
  );
  return candidate === undefined || candidate.eligible
    ? null
    : `${policy.name} will not take a build from ${adapter.name}: ${candidate.reason}`;
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

  // §4: "concurrent builds up to a per-App limit". Counted rather than queued,
  // because §4 also removes the ordinal — a build records an artifact rather
  // than deploying one, so nothing is waiting on a slot and refusing is a more
  // honest answer than a queue whose position means nothing.
  const running = await context.db
    .select({ id: builds.id })
    .from(builds)
    .innerJoin(components, eq(builds.componentId, components.id))
    .where(and(eq(components.appId, app.id), eq(builds.status, 'RUNNING')));
  if (running.length >= CONCURRENT_BUILDS_PER_APP) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name} already has ${running.length} builds running, which is this installation's limit`,
    );
  }

  // §16: "the level is a threshold, then admin rank wins." The threshold half
  // is the Target's, so it is only checkable where a placement is named — and
  // where one is, a route below it is refused here rather than producing an
  // artifact the Target would refuse to admit anyway.
  const targetPolicy = await targetBuildPolicy(
    context,
    input.placementTargetId,
  );
  const refusal = routeRefusedByTarget(targetPolicy, adapter);
  if (refusal !== null) return failed('NOT_BUILDABLE', refusal);

  // The staged bundle's own columns, not the artifact's. §15 stages a bundle for
  // either builder — a repo commit and an upload alike — and a Build that has
  // not run has no artifact refs to borrow an address from, so a missing
  // location is what would otherwise reach a route as an empty URL.
  if (build.bundleLocation === null) {
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle location, so no route can fetch it`,
    );
  }

  const source: Source =
    app.sourceKind === 'repo'
      ? {
          kind: 'repo',
          url: app.sourceRepoUrl ?? '',
          commit: build.commit,
          // §5: an App is repo plus subpath, and the developer named it there.
          subpath: app.sourceRepoSubpath ?? '.',
          location: build.bundleLocation,
        }
      : {
          kind: 'archive',
          digest: build.bundleDigest,
          location: build.bundleLocation,
          contents: 'source',
          // Per Build: the unwrap is a fact about the bytes that were uploaded.
          subpath: build.bundleSubpath ?? '.',
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
    /**
     * §4: "a website's build-time config is passed as build arguments as
     * ordinary rows, not fetched from a store — whatever a website bakes
     * becomes public anyway, so no builder ever holds a store credential."
     *
     * Read here rather than by the route, so that the one place a value
     * reaches a builder is the one place the contract says it may.
     */
    buildArgs:
      input.placementTargetId === undefined ||
      !isBuildTimeConfig(component.kind)
        ? {}
        : await readBuildArgs(
            context.db,
            component.id,
            input.placementTargetId,
          ),
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

  const finalized = await context.adapters.supplyChain().finalize({
    artifact: result.artifact,
    provenance: result.provenance,
    backend: adapter.name,
    expectedBuilderId: adapter.provenanceBuilderId,
    maximumLevel: adapter.buildLevel,
    // A shape-only Build has no Target policy yet. It is assessed at the
    // route's achieved level and every actual Deploy checks the Target's current
    // threshold again, which is what makes a later policy raise prospective.
    minimumLevel: targetPolicy?.minimumLevel ?? 1,
    source: buildSource,
  });
  if (!finalized.ok) {
    await recordBuildEvent(context.db, attempt, {
      type: 'log',
      line: `supply-chain admission failed: ${finalized.message}`,
      resource: 'provenance',
    });
    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: 'BUILD_FAILED',
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
      provenance: finalized.assessment,
      verifiedBuildLevel: finalized.assessment.achievedLevel,
      signature: finalized.signature,
      buildkitProvenanceRef: result.buildkitProvenanceRef,
      sbomRef: result.sbomRef,
    })
    .where(eq(builds.id, build.id));

  return ok({
    buildId: build.id,
    status: 'SUCCEEDED' as const,
    artifactDigest: result.artifact.digest,
    runner: adapter.name,
  });
};
