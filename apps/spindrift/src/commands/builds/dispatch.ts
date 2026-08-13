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
import { and, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type {
  BuildAdapter,
  BuildSource,
  BuildSpec,
} from '../../adapters/build/contract.ts';
import type { FailureReason } from '../../adapters/deploy/contract.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  repositories,
  targets,
  vessels,
} from '../../db/schema.ts';
import {
  artifactTags,
  componentRepositories,
  publishableRegistries,
  registryFlavour,
  registryHostOf,
} from '../../domain/artifact-name.ts';
import {
  type BuildAttemptRef,
  recordBuildEvent,
} from '../../domain/attempt-log.ts';
import {
  buildRouteCandidates,
  DEFAULT_MINIMUM_BUILD_LEVEL,
} from '../../domain/build-route.ts';
import { vercelFrameworkOf } from '../../domain/detection/declared.ts';
import { parseSpindriftFile } from '../../domain/detection/spindrift-file.ts';
import { DEFAULT_PLATFORM } from '../../domain/placement.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import { buildOriginOf, type Source } from '../../domain/source.ts';
import { targetLabel } from '../../domain/target.ts';
import { SPINDRIFT_FILE } from '../../integrations/github/config-pr.ts';
import { isFetchableBundleLocation } from '../../storage/archives.ts';
import { parseGcsLocation, signedObjectUrl } from '../../storage/signed-url.ts';
import { isBuildTimeConfig, readBuildArgs } from '../config/build-args.ts';
import {
  type CommandContext,
  type CommandFailureCode,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

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

/** Duration after which a RUNNING build's dispatch lease is considered expired. */
export const DISPATCH_LEASE_TIMEOUT_MS = 10 * 60 * 1000;

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
    /**
     * Optional durable identity for this dispatch attempt/lease.
     * When omitted, a unique ID is generated for the claim.
     */
    dispatchId: z.string().trim().min(1).optional(),
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
  /** The durable dispatch identity for this run. */
  readonly dispatchId: string;
}

export type BuildDispatchContext = Pick<
  CommandContext,
  'db' | 'adapters' | 'clock' | 'manifest'
>;

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
  context: Pick<CommandContext, 'db'>,
  targetId: string | undefined,
): Promise<TargetBuildPolicy | null> {
  if (targetId === undefined) return null;
  const [target] = await context.db
    .select({
      vessel: vessels.name,
      adapter: targets.adapter,
      minBuildLevel: targets.minBuildLevel,
    })
    .from(targets)
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(targets.id, targetId));
  if (target === undefined) return null;
  return {
    name: targetLabel(target),
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

/**
 * The stored bundle address, turned into one a builder can actually fetch.
 *
 * A depot address is `gs://bucket/object`: durable, shared between replicas,
 * and unresolvable by anything without a Google credential — which every
 * builder §15 stages for is, because the hosted route's runner is a machine on
 * the public internet. So it is exchanged here for a short-TTL V4 signed URL.
 *
 * **A failure to mint one is a refusal, not a warning.** Dispatching anyway
 * hands a route an address it cannot resolve, so the workflow fails at its first
 * step and sends the developer to debug a Dockerfile over a location Spindrift
 * itself made unusable. A refusal costs one dispatch and says the true thing.
 *
 * An `https://` location is already fetchable and passes through untouched.
 * **Anything else is refused here rather than forwarded.** An `upload://` handle
 * is honest about being unfetchable, but forwarding it means the honesty arrives
 * as `curl: (1) Protocol "upload" not supported or disabled in libcurl` on a
 * hosted runner, after a dispatch — a CI log the operator has to read for a
 * refusal this function makes for free.
 */
async function fetchableBundleLocation(
  context: Pick<BuildDispatchContext, 'manifest'>,
  app: Pick<typeof apps.$inferSelect, 'name' | 'sourceKind'>,
  location: string,
): Promise<CommandResult<string>> {
  if (parseGcsLocation(location) === null) {
    if (isFetchableBundleLocation(location)) return ok(location);
    // The remedy differs by source, because re-staging does: a repository can be
    // fetched again at the same commit, while the bytes behind an archive only
    // ever existed as what a developer uploaded.
    const remedy =
      app.sourceKind === 'repo'
        ? `deploy ${app.name} again to stage a fresh bundle from its repository`
        : `upload ${app.name}'s archive again to stage it in the depot`;
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s staged bundle is at ${location}, which names this installation's own disk rather than anything a build route can fetch — ${remedy}`,
    );
  }

  const federation = context.manifest?.cloud?.federation ?? null;
  if (federation === null) {
    return failed(
      'NOT_BUILDABLE',
      `the staged bundle is in cloud storage and this installation configures no federation to reach it, so no route could fetch ${location}`,
    );
  }

  try {
    return ok(await signedObjectUrl({ location, federation }));
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    // The object path, never the URL: a signed URL is a bearer capability and
    // this sentence lands on the operator-visible attempt log.
    return failed(
      'NOT_BUILDABLE',
      `could not mint a signed URL for the staged bundle at ${location}, so no route could fetch it: ${detail}`,
    );
  }
}

/**
 * Where a `files` build lifts its site out of, at this build's own commit.
 *
 * §5 makes a scope's `spindrift.yaml` the home of record — "once it is on the
 * default branch it wins over detection" — and the repo loop parses one per
 * commit without storing what it read. So this asks the same file the same
 * question at the commit being built, rather than reading a column that would
 * describe whichever commit last wrote it.
 *
 * **Every unknown answers `null`, and `null` ships the scope as it stands** —
 * which is exactly what a `files` build did before this field existed. A scope
 * with no Spindrift file, a file that no longer parses, an installation with no
 * repository integration, an uploaded archive, a repository the host would not
 * answer for: none of them is a reason to fail a build that would otherwise
 * have succeeded, and all of them are reasons to lift nothing.
 *
 * The Dockerfile arm has no output directory *by construction* rather than by
 * omission: a scope that builds itself from a Dockerfile renders a server, and
 * §5 gives it no field to name a directory with.
 */
/**
 * Which framework a `vercel-output` build declares, read at this build's commit.
 *
 * The same shape as {@link outputDirectoryFor} and one difference that matters:
 * `null` here is fatal rather than benign. A missing output directory means
 * "ship the scope", which is a real answer; a missing framework means the
 * platform's builder would be told nothing, and it does not guess — it builds
 * the project as "Other", copies the tree to `static/`, and emits no functions.
 * That is a build that succeeds and serves an SSR app's sources, so
 * `dispatchBuild` refuses on `null` instead of running one.
 */
async function vercelFrameworkFor(
  context: Pick<CommandContext, 'adapters'>,
  input: {
    readonly artifactType: BuildSpec['artifactType'];
    readonly source: Source;
    readonly repository: {
      readonly installationId: string;
      readonly fullName: string;
    } | null;
  },
): Promise<string | null> {
  if (input.artifactType !== 'vercel-output') return null;
  if (input.source.kind !== 'repo') return null;
  if (input.repository === null) return null;
  const host = context.adapters.repository();
  if (host === null) return null;

  const path =
    input.source.subpath === '.'
      ? 'package.json'
      : `${input.source.subpath}/package.json`;

  let manifest: string | null;
  try {
    manifest = await host.readFile(
      repositoryRefOf(input.repository),
      input.repository.fullName,
      input.source.commit,
      path,
    );
  } catch {
    return null;
  }
  if (manifest === null) return null;
  return vercelFrameworkOf(manifest);
}

async function outputDirectoryFor(
  context: Pick<CommandContext, 'adapters'>,
  input: {
    readonly artifactType: BuildSpec['artifactType'];
    readonly source: Source;
    readonly repository: {
      readonly installationId: string;
      readonly fullName: string;
    } | null;
  },
): Promise<string | null> {
  // An image is the tree's own build product, so there is nothing to lift out
  // of it and the question does not arise.
  if (input.artifactType !== 'files') return null;
  // An upload carries no repository to read a file out of. A supplied artifact
  // is finished output already (§4), and an uploaded *source* archive has no
  // default branch for §5's file to have won on.
  if (input.source.kind !== 'repo') return null;
  if (input.repository === null) return null;
  const host = context.adapters.repository();
  if (host === null) return null;

  const path =
    input.source.subpath === '.'
      ? SPINDRIFT_FILE
      : `${input.source.subpath}/${SPINDRIFT_FILE}`;

  let document: string | null;
  try {
    document = await host.readFile(
      repositoryRefOf(input.repository),
      input.repository.fullName,
      input.source.commit,
      path,
    );
  } catch {
    return null;
  }
  if (document === null) return null;

  try {
    const proposal = parseSpindriftFile(document, path);
    return proposal.build.frontend === 'railpack'
      ? proposal.build.outputDirectory
      : null;
  } catch {
    return null;
  }
}

/**
 * How a dispatch refusal is recorded, and why there are exactly two ways.
 *
 * Everything below the Build row's own existence is refused *before* the claim
 * transaction, which means the refusal is returned to `runBuildPass` — and
 * `runBuildPass` is `if (result.ok) dispatched += 1`. It keeps the successes and
 * drops everything else. A refusal that only returns therefore reaches nobody,
 * and the Build sits PENDING being refused again every second in silence.
 *
 * What separates the two arms is not severity, it is **whether a later tick can
 * clear it**:
 *
 * - `closes` — the refusal is a fact about this row. A location no route can
 *   fetch, a name no registry will accept, a bundle that was never staged: no
 *   tick makes any of those legal, so the Build is failed with §6's reason and
 *   the sentence goes on the attempt log. Retrying it once a second forever is
 *   the alternative, and it is not one.
 * - `waits` — the refusal is a fact about the *installation*. Federation that
 *   is not configured, a route this installation does not have, a Target
 *   threshold no configured route meets: configuring the thing is a thing an
 *   operator can do, and the next tick should then work without anybody
 *   pressing Deploy again. So the Build stays PENDING — and says what it is
 *   waiting on, which is the half that was missing.
 *
 * That gap cost real time. Build 13 sat PENDING for two hours over a missing
 * `roles/iam.serviceAccountTokenCreator` binding while
 * {@link fetchableBundleLocation} composed the true sentence once a second and
 * threw it away every time; it was finally named by reading Terraform, not by
 * anything Spindrift said. The sentence existed. Nobody could see it.
 *
 * Repeat suppression is what makes the `waits` arm bearable at 1Hz, and it is
 * keyed on `builds.dispatchWaitingOn` — the row is already in hand, so an
 * unchanged refusal costs no query and writes nothing. A *changed* one writes,
 * because a refusal that has changed is news.
 */
type RefusalDisposition =
  | { readonly kind: 'closes'; readonly reason: FailureReason }
  | { readonly kind: 'waits' };

/** Everything {@link refuseDispatch} needs to know about the Build it is refusing. */
export interface RefusalSubject {
  readonly attempt: BuildAttemptRef;
  /** `builds.dispatchWaitingOn` as it stands, for suppressing a repeat. */
  readonly waitingOn: string | null;
}

async function refuseDispatch<Output>(
  context: Pick<BuildDispatchContext, 'db'>,
  subject: RefusalSubject,
  code: CommandFailureCode,
  sentence: string,
  disposition: RefusalDisposition,
): Promise<CommandResult<Output>> {
  if (disposition.kind === 'closes') {
    await recordBuildEvent(context.db, subject.attempt, {
      type: 'log',
      line: sentence,
      resource: 'dispatch',
    });
    await recordBuildEvent(context.db, subject.attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: disposition.reason,
    });
    await context.db
      .update(builds)
      // Cleared with the same statement that ends the wait: a FAILED Build is
      // not waiting on anything, and leaving the sentence behind would read as
      // though it were.
      .set({ status: 'FAILED', dispatchWaitingOn: null })
      .where(eq(builds.id, subject.attempt.buildId));
    return failed(code, sentence);
  }

  await recordDispatchWait(context, subject, sentence);
  return failed(code, sentence);
}

/**
 * Say once, on the attempt log, what a PENDING Build is waiting for.
 *
 * Exported because one refusal of this class is made before `dispatchBuild` is
 * ever called: `runBuildPass` selects a route for the Target and skips the
 * Build when there is none, so the sentence has to be written from there. It is
 * the same disposition and the same suppression, which is why it is the same
 * function rather than a second one that drifts.
 *
 * No status event is written: the Build has not failed and its phase has not
 * moved. It is PENDING, which is what it was, and the log now says why it
 * still is.
 */
export async function recordDispatchWait(
  context: Pick<BuildDispatchContext, 'db'>,
  subject: RefusalSubject,
  sentence: string,
): Promise<void> {
  if (subject.waitingOn === sentence) return;
  await recordBuildEvent(context.db, subject.attempt, {
    type: 'log',
    line: sentence,
    resource: 'dispatch',
  });
  await context.db
    .update(builds)
    .set({ dispatchWaitingOn: sentence })
    .where(eq(builds.id, subject.attempt.buildId));
}

export const dispatchBuild = async (
  input: DispatchBuildInput,
  context: BuildDispatchContext,
): Promise<CommandResult<DispatchBuildResult>> => {
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
  const [repository] =
    app.repositoryId === null
      ? []
      : await context.db
          // `installationId` rides along for `outputDirectoryFor`, which reads
          // this build's commit as the installation that owns the repository.
          .select({
            fullName: repositories.fullName,
            installationId: repositories.installationId,
          })
          .from(repositories)
          .where(eq(repositories.id, app.repositoryId))
          .limit(1);

  // §4's supplied artifact: an archive of finished output already *is* the
  // artifact, digested over the bundle core staged. There is no route to run and
  // running one would produce a second digest over the same bytes.
  if (build.status === 'SUCCEEDED' && build.artifactDigest !== null) {
    return ok({
      buildId: build.id,
      status: 'SUCCEEDED' as const,
      artifactDigest: build.artifactDigest,
      runner: build.runner ?? 'supplied',
      dispatchId: build.dispatchId ?? input.dispatchId ?? 'supplied',
    });
  }

  // Everything from here down can refuse, and every refusal below is made
  // before the claim — so every one of them is dropped by `runBuildPass` unless
  // it is written somewhere first. See {@link refuseDispatch}: the App and the
  // Component are known by now, which is all an attempt reference needs, so the
  // subject is assembled once and each refusal only has to say which of the two
  // dispositions it is.
  const subject: RefusalSubject = {
    attempt: {
      appId: app.id,
      componentId: component.id,
      buildId: build.id,
    },
    waitingOn: build.dispatchWaitingOn,
  };

  if (build.bundleDigest === null) {
    // §16: "the bundle digest must be a build parameter on every route, or the
    // correlation between a source receipt and a provenance document has no
    // join." A Build without one cannot be dispatched at all — and no tick
    // stages one, because staging happens where the Build is created.
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle, so no route can be given one`,
      { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
    );
  }

  const adapter = context.adapters.build(input.route);
  if (adapter === null) {
    // The route set is §4's installation configuration, so this names a
    // prerequisite rather than a defect: an operator who configures the route
    // gets this Build dispatched on the next tick.
    return refuseDispatch(
      context,
      subject,
      'NOT_FOUND',
      `this installation has no build route named ${input.route}, so nothing can run this Build until one is configured`,
      { kind: 'waits' },
    );
  }

  // Target binding: if a Component has multiple placements, dispatch must name an explicit placementTargetId.
  // If there is only one placement, default to it.
  const placements = await context.db
    .select({ targetId: componentTargetDesired.targetId })
    .from(componentTargetDesired)
    .where(eq(componentTargetDesired.componentId, component.id));

  let effectiveTargetId = input.placementTargetId;
  if (effectiveTargetId !== undefined) {
    if (
      placements.length > 0 &&
      !placements.some((p) => p.targetId === effectiveTargetId)
    ) {
      // Placements are rows an operator edits, so this is `waits` for the same
      // reason a missing route is: it is not reachable from the loop at all
      // (the loop dispatches the placement it read), and where it does arrive
      // the remedy is a placement, not a rebuild.
      return refuseDispatch(
        context,
        subject,
        'NOT_BUILDABLE',
        `Target ${effectiveTargetId} is not a placement target for Component ${component.id}`,
        { kind: 'waits' },
      );
    }
  } else {
    if (placements.length === 1) {
      effectiveTargetId = placements[0]!.targetId;
    } else if (placements.length > 1) {
      return refuseDispatch(
        context,
        subject,
        'NOT_BUILDABLE',
        `Component ${component.id} has multiple target placements, so dispatch must name an explicit placementTargetId`,
        { kind: 'waits' },
      );
    }
  }

  // §16: "the level is a threshold, then admin rank wins." The threshold half
  // is the Target's, so it is only checkable where a placement is named — and
  // where one is, a route below it is refused here rather than producing an
  // artifact the Target would refuse to admit anyway.
  //
  // `waits`, because both halves of the comparison are configuration: the
  // Target's threshold and the set of routes this installation offers. Lowering
  // one or adding a better route makes the next tick work.
  const targetPolicy = await targetBuildPolicy(context, effectiveTargetId);
  const refusal = routeRefusedByTarget(targetPolicy, adapter);
  if (refusal !== null) {
    return refuseDispatch(context, subject, 'NOT_BUILDABLE', refusal, {
      kind: 'waits',
    });
  }

  // The staged bundle's own columns, not the artifact's. §15 stages a bundle for
  // either builder — a repo commit and an upload alike — and a Build that has
  // not run has no artifact refs to borrow an address from, so a missing
  // location is what would otherwise reach a route as an empty URL.
  if (build.bundleLocation === null) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `Build ${build.id} has no staged bundle location, so no route can fetch it`,
      { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
    );
  }

  // The durable address becomes a fetchable one here and nowhere earlier. A
  // signed URL is a bearer capability with a TTL in minutes, so minting it at
  // dispatch is what keeps it out of the Build row, out of the attempt log, and
  // out of any window between staging and running. What is persisted is the
  // `gs://` object; what a route is handed is a URL that resolves.
  const attempt = subject.attempt;

  /**
   * §16 names one registry per installation — "every artifact is pushed to and
   * pulled from" it — and a Build is keyed on a *shape*, not on a Target (§2),
   * so there is no Target here to read a reachable registry off. That is the
   * right way round: whether a Target can reach the registry is a placement
   * filter (§3's `reachableRegistries`), applied before the build, not a choice
   * the build makes. An adapter never picks its own destination (§4).
   *
   * What §16 names is a **namespace**, so a repository is composed under it
   * here. Refused rather than projected when a name cannot be a path segment:
   * the registry would answer `NAME_INVALID` at the last step of the build, and
   * projecting instead would push two Components to one repository. Recorded
   * and closed out like an unfetchable location, because a name is a column on
   * these rows and no later tick makes it legal — an operator renaming the App
   * or the Component is what clears it.
   *
   * Ahead of the signed URL deliberately: a bearer capability minted for a
   * Build that cannot be dispatched is one that exists for no reason.
   */
  const allRegistries = context.manifest.supplyChain.registry;
  /**
   * The registries **this route** can publish to, which is not always all of
   * them (§13).
   *
   * §16 pushes every artifact to every registry, and that reads as unconditional
   * until you ask what authorizes each push. §13 answers "the route that makes
   * it", and the three routes do not reach the same set: the hosted run logs
   * into GHCR and federates to the artifact registry, while the cloud builder's
   * metadata token is good for one vendor's registries and nothing else.
   *
   * `buildctl` exports every reference in one operation, so an unauthorized
   * destination is not a destination that gets skipped — it is a `401` that
   * fails the whole export, with the image built and nothing published
   * anywhere. Narrowing is what makes a cloud build land in the artifact
   * registry by default instead of failing at the last step, and stored
   * credentials widen it back for a host no federation reaches.
   *
   * The consequence is deliberate and is the one an App choosing a route signs
   * up for: an artifact in fewer registries is an artifact fewer Targets can
   * pull. `setAppBuildRoute` refuses that combination up front rather than
   * letting a green Build discover it at the deploy.
   */
  const storedHosts = new Set(
    (await context.adapters.registryCredentials?.()?.list())?.map(
      (one) => one.host,
    ) ?? [],
  );
  const registries = publishableRegistries({
    registries: allRegistries,
    selfAuthorized: adapter.selfAuthorizedRegistries,
    storedHosts,
  });
  if (registries.length === 0) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `the "${adapter.name}" route can authorize a push to none of the ` +
        `registries this installation publishes to (${allRegistries.join(', ')}), ` +
        'so a build on it would have nowhere to put the artifact. Store a ' +
        'registry credential for one of them, or build on a route whose own ' +
        'identity reaches one.',
      // Both halves are configuration an operator can supply, and the next tick
      // then works without anyone pressing Deploy again.
      { kind: 'waits' },
    );
  }
  const destinations = componentRepositories({
    registries,
    app: app.name,
    component: component.name,
  });
  if (destinations === null) {
    const sentence =
      `App "${app.name}" / Component "${component.name}" cannot name a ` +
      `repository under ${registries.join(' or ')}: a registry ` +
      `path segment is lowercase alphanumerics separated by "-", "_" or "."`;
    // §6's table covers "invalid spec" here, which is what a name no registry
    // will accept is — and it blames the developer, who is the one who can
    // rename the thing.
    return refuseDispatch(context, subject, 'NOT_BUILDABLE', sentence, {
      kind: 'closes',
      reason: 'REJECTED',
    });
  }

  const fetchable = await fetchableBundleLocation(
    context,
    app,
    build.bundleLocation,
  );
  if (!fetchable.ok) {
    // Both dispositions come out of this one function, and which one is decided
    // by the location rather than by the error. Where the location itself is
    // the problem it is a column on this row and no later tick makes it
    // fetchable, so the Build is closed out — §6's `ARTIFACT_UNAVAILABLE` is
    // the platform-blamed reason for an object that is not there to be fetched.
    //
    // The other refusals are about this installation's federation rather than
    // about this row, so they wait: configuring federation is a thing an
    // operator can do that makes the next tick work. **This is the arm that
    // recorded nothing at all**, and it is the one build 13 sat two hours in.
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      fetchable.failure.message,
      isFetchableBundleLocation(build.bundleLocation)
        ? { kind: 'waits' }
        : { kind: 'closes', reason: 'ARTIFACT_UNAVAILABLE' },
    );
  }

  const source: Source =
    app.sourceKind === 'repo'
      ? {
          kind: 'repo',
          url: repository?.fullName ?? app.sourceRepoUrl ?? '',
          commit: build.commit,
          // §5: an App is repo plus subpath, and the developer named it there.
          subpath: app.sourceRepoSubpath ?? '.',
          location: fetchable.value,
        }
      : {
          kind: 'archive',
          digest: build.bundleDigest,
          location: fetchable.value,
          contents: 'source',
          // Per Build: the unwrap is a fact about the bytes that were uploaded.
          subpath: build.bundleSubpath ?? '.',
        };

  const buildSource: BuildSource = {
    bundleDigest: build.bundleDigest,
    origin: buildOriginOf(source),
  };

  /**
   * The stored registry credentials the destinations of this build need (§16).
   *
   * §13 wants every push authorized by the route that makes it, and where that
   * works this is empty and nothing is handed over. What it covers is the gap
   * federation cannot: Docker Hub trusts no federated identity, so a push there
   * either carries a token or fails at the last step of a green build.
   *
   * Opened here and nowhere else. The plaintext exists for the length of this
   * request, reaches exactly one route, and is never written to the Build row,
   * the attempt log, or an event — `dispatchWaitingOn` below carries sentences
   * an operator reads, and none of them can name a secret because none of them
   * is composed from one.
   */
  const credentials = context.adapters.registryCredentials?.() ?? null;
  /**
   * **Only the hosts this route cannot authorize on its own.** The same
   * `selfAuthorizedRegistries` that chose the destinations above decides this,
   * because they are the same question asked twice: a flavour the route's own
   * identity reaches needs no credential handed to it, and asking for one
   * anyway produces a credential that is unnecessary, unused, and — on a route
   * that cannot carry one — fatal.
   *
   * That was not hypothetical. GHCR's credential is *minted per dispatch* from
   * the GitHub OAuth the installation already holds
   * (`storage/github-registry-credential.ts`), so it answers whenever the
   * connector is authorized. Asking about every destination therefore always
   * produced one for `ghcr.io`, and the refusal below fired on every single
   * build on the hosted route — the route whose own workflow logs into GHCR
   * with the run's token and needs nothing from here.
   */
  const unauthorizedHosts = [
    ...new Set(destinations.map(registryHostOf)),
  ].filter(
    (host) => !adapter.selfAuthorizedRegistries.includes(registryFlavour(host)),
  );
  const registryAuth = (await credentials?.authFor(unauthorizedHosts)) ?? [];

  // A route that cannot carry one is refused **before** the claim, so nothing
  // is dispatched that would fail at the push — or, worse, put the credential
  // where the route puts its inputs. `waits`, because both halves are
  // configuration: admitting a different route on the Target, or forgetting a
  // credential this registry did not need, makes the next tick work.
  if (registryAuth.length > 0 && !adapter.carriesRegistryCredential) {
    const hosts = registryAuth.map((one) => one.host).join(', ');
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `this installation holds a registry credential for ${hosts}, and the ` +
        `"${adapter.name}" route cannot carry one — its dispatch inputs are ` +
        'readable by anyone who can see the run. Admit a route that runs the ' +
        'build in a container of its own, or remove the credential if that ' +
        'registry does not need one.',
      { kind: 'waits' },
    );
  }

  const spec: BuildSpec = {
    artifactType: build.artifactType,
    kind: component.kind,
    platform: DEFAULT_PLATFORM,
    destinations,
    registryAuth,
    /**
     * §12 counts tags, so a push that carried only the implicit `:latest` would
     * leave retention nothing to act on and a rollback depth of one.
     */
    tags: artifactTags(build.bundleDigest),
    /**
     * §4: "a website's build-time config is passed as build arguments as
     * ordinary rows, not fetched from a store — whatever a website bakes
     * becomes public anyway, so no builder ever holds a store credential."
     *
     * Read here rather than by the route, so that the one place a value
     * reaches a builder is the one place the contract says it may.
     */
    buildArgs:
      effectiveTargetId === undefined || !isBuildTimeConfig(component.kind)
        ? {}
        : await readBuildArgs(context.db, component.id, effectiveTargetId),
    /**
     * §3, story 42: a website placed on a static Target is the files its build
     * leaves behind, not the tree that produced them.
     *
     * Read here, from this build's own commit, for the reason the field's
     * documentation gives: the answer lives in the scope's `spindrift.yaml`
     * and moves with the tree, so the only correct time to ask is while
     * composing the spec for one commit.
     */
    outputDirectory: await outputDirectoryFor(context, {
      artifactType: build.artifactType,
      source,
      repository: repository ?? null,
    }),
    vercelFramework: await vercelFrameworkFor(context, {
      artifactType: build.artifactType,
      source,
      repository: repository ?? null,
    }),
  };

  // §3: the shape was resolved before this build, and this is the one shape
  // that cannot be built from the shape alone. Refused here rather than in the
  // runner because the alternative is not a red build — it is a green one that
  // served the sources, which nobody reading a successful run would think to
  // check. `waits` rather than `closes`: adding the missing dependency is a
  // thing a developer does that makes the next tick work.
  if (spec.artifactType === 'vercel-output' && spec.vercelFramework === null) {
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `${component.name} is placed on a Vercel Target, which builds through the platform's own framework builder — and nothing in this scope's package.json names a framework Spindrift recognises. Vercel performs no detection of its own: a build with no framework is built as a plain directory of files and would serve this project's sources with no functions at all, so it is refused instead.`,
      { kind: 'waits' },
    );
  }

  const dispatchId = input.dispatchId ?? crypto.randomUUID();
  const now = context.clock?.now() ?? new Date();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);

  const claimResult = await context.db.transaction(async (tx) => {
    // Lock app row so per-App concurrency check and claim are atomic across reconciler replicas
    await tx
      .select({ id: apps.id })
      .from(apps)
      .where(eq(apps.id, app.id))
      .for('update');

    const running = await tx
      .select({ id: builds.id })
      .from(builds)
      .innerJoin(components, eq(builds.componentId, components.id))
      .where(
        and(
          eq(components.appId, app.id),
          eq(builds.status, 'RUNNING'),
          or(isNull(builds.leasedAt), gte(builds.leasedAt, leaseCutoff)),
        ),
      );

    if (running.length >= CONCURRENT_BUILDS_PER_APP) {
      return { type: 'CONCURRENCY_EXCEEDED' as const, count: running.length };
    }

    const [claimedRow] = await tx
      .update(builds)
      .set({
        status: 'RUNNING',
        runner: adapter.name,
        logFidelity: adapter.logFidelity,
        dispatchId,
        leasedAt: now,
        // The wait is over, so what it was waiting on stops being true. Cleared
        // here rather than left to age out, so that a Build whose lease expires
        // and is refused again reports it again instead of being suppressed
        // against a sentence from a previous attempt.
        dispatchWaitingOn: null,
      })
      .where(
        and(
          eq(builds.id, build.id),
          or(
            eq(builds.status, 'PENDING'),
            eq(builds.dispatchId, dispatchId),
            and(
              eq(builds.status, 'RUNNING'),
              isNotNull(builds.leasedAt),
              lt(builds.leasedAt, leaseCutoff),
            ),
          ),
        ),
      )
      .returning({ id: builds.id, dispatchId: builds.dispatchId });

    if (claimedRow !== undefined) {
      return {
        type: 'CLAIMED' as const,
        dispatchId: claimedRow.dispatchId ?? dispatchId,
      };
    }

    return { type: 'NOT_CLAIMED' as const };
  });

  if (claimResult.type === 'CONCURRENCY_EXCEEDED') {
    // `waits`, and the one refusal in this file that clears itself: the
    // prerequisite is a free slot, which a running sibling gives up on its own.
    // Recorded anyway, because "PENDING and not moving" looks identical to the
    // developer whether the cause is a queue or a missing IAM binding, and the
    // difference is the whole of what they want to know.
    return refuseDispatch(
      context,
      subject,
      'NOT_BUILDABLE',
      `${app.name} already has ${claimResult.count} builds running, which is this installation's limit`,
      { kind: 'waits' },
    );
  }

  if (claimResult.type === 'NOT_CLAIMED') {
    const [current] = await context.db
      .select({
        status: builds.status,
        artifactDigest: builds.artifactDigest,
        runner: builds.runner,
        dispatchId: builds.dispatchId,
      })
      .from(builds)
      .where(eq(builds.id, build.id));
    if (current?.status === 'SUCCEEDED') {
      return ok({
        buildId: build.id,
        status: 'SUCCEEDED',
        artifactDigest: current.artifactDigest,
        runner: current.runner ?? 'supplied',
        dispatchId: current.dispatchId ?? dispatchId,
      });
    }
    if (current?.status === 'FAILED') {
      return ok({
        buildId: build.id,
        status: 'FAILED',
        artifactDigest: null,
        runner: current.runner ?? adapter.name,
        dispatchId: current.dispatchId ?? dispatchId,
      });
    }
    // Deliberately not recorded. Losing the claim is not a refusal to report to
    // anybody: another replica won the same row and is writing that Build's log
    // right now, so a line here would say "not dispatched" underneath the events
    // of the dispatch that did happen.
    return failed(
      'NOT_BUILDABLE',
      `Build ${build.id} is already running on ${current?.runner ?? adapter.name}`,
    );
  }

  const activeDispatchId = claimResult.dispatchId;

  try {
    const stream = adapter.build(buildSource, spec);
    let next = await stream.next();
    while (!next.done) {
      const event = next.value;
      // Where the run can be watched is a fact about the Build, not a line in
      // its log — and it is written as soon as the route reports it so the
      // screen can offer it *during* the run, which is the whole of its value
      // on a `LIVE_STATUS` route whose text arrives only at the end.
      if (event.type === 'runner') {
        await context.db
          .update(builds)
          .set({ runUrl: event.url })
          .where(eq(builds.id, build.id));
        next = await stream.next();
        continue;
      }
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
        dispatchId: activeDispatchId,
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
        dispatchId: activeDispatchId,
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
      dispatchId: activeDispatchId,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    await recordBuildEvent(context.db, attempt, {
      type: 'log',
      line: `build dispatch failed: ${detail}`,
    });
    await recordBuildEvent(context.db, attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: 'INTERNAL',
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
      dispatchId: activeDispatchId,
    });
  }
};
