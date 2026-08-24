/**
 * `deployApp` — deploy an App's newest artifact, or start the Build it needs
 * (§2, §4, §6).
 *
 * The workspace has one button, so this command decides which of two acts the
 * operator meant. What it may never do is quietly substitute one for the other.
 *
 * - **There is a succeeded Build with an artifact.** The intent goes through
 *   {@link createDeploy}, the one path that takes §6's locking read on the
 *   desired row behind `checkDeployable`'s gates — Target connected, artifact
 *   present, signature re-verified against the recorded digest, verified Build
 *   Level at or above the Target's policy, artifact shape matched, config
 *   migration satisfied. **Its refusal is returned unchanged.** A refusal is a
 *   fact about the world carrying the sentence the operator has to read —
 *   "Build 4 signature did not verify", "that Target is disconnected, so
 *   nothing new can be placed on it" — and rebuilding instead would answer a
 *   question nobody asked while hiding the one that was.
 * - **There is nothing deployable yet** — no Build at all, the last one failed,
 *   or it succeeded without an artifact. A PENDING Build is written for the
 *   build loop to dispatch, and that is the whole act. It is written with a
 *   bundle staged *for it* rather than the previous Build's, which is
 *   {@link sourceForRerun}'s subject and §15's "stage an immutable source
 *   bundle" read as being about a Build rather than about an App.
 *
 * `rebuild` is the operator asking for the second act where the first was
 * available — the one question the button above cannot express, because its
 * whole design is to answer the deployable case with a Deploy. Without it an
 * App whose newest Build succeeded has **no path to a new Build at all**: the
 * branch below is the only caller of {@link sourceForRerun}, and reaching it
 * meant writing `status = 'FAILED'` onto a Build that genuinely succeeded. It
 * changes which act runs and nothing else — the same staging, the same row, the
 * same refusals — and the result still says which of the two happened, so the
 * substitution this command forbids stays forbidden in both directions.
 *
 * `commit` is the other way the caller decides which act, and it is the one
 * §15's dispatcher uses. The two are different questions: `rebuild` is "build
 * again whatever is there", `commit` is "this act is about *this* commit", and
 * a push is only the second. Where the newest Build already carries the named
 * commit, the acts are the same as they always were — deploy it if it
 * succeeded, wait if it is still building, and where it is already what is
 * desired on the pair, do nothing at all. Where it does not, the deployable
 * branch is not deployable *for this caller*: taking it meant a push adopted a
 * commit and then placed the artifact built from the one before it.
 *
 * **This command writes no `deploys` row of its own**, on either branch. That
 * is the point rather than an omission: §6's check-and-set is only a
 * correctness argument if every intent is written through the one pair that
 * implements it — `checkDeployable` then `placeIntent` — which is what
 * `createDeploy` composes and what `rollbackDeploy` and `setConfig` call
 * directly, and is why all of them refuse identically. A Build that has not
 * succeeded could not pass `checkDeployable` anyway, so an intent written for
 * one here would name an artifact that does not exist (§4: "a build records an
 * artifact rather than deploying one").
 */
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import { targetAdapterSchema } from '../../config/manifest.schema.ts';
import {
  type apps,
  builds,
  components,
  componentTargetDesired,
  repositories,
  targets,
  vessels,
} from '../../db/schema.ts';
import { artifactTypeFor, placementTargetOf } from '../../domain/placement.ts';
import { repositoryRefOf } from '../../domain/repository.ts';
import type { CommitHeadline } from '../../domain/source-bundle.ts';
import {
  isEphemeralBundleLocation,
  isFetchableBundleLocation,
} from '../../storage/archives.ts';
import { DISPATCH_LEASE_TIMEOUT_MS } from '../builds/dispatch.ts';
import { createDeploy } from '../deploys/create.ts';
import {
  type Command,
  type CommandContext,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

export const deployAppInput = z
  .object({
    /** The App's id, or its name where that names exactly one App. */
    name: z.string().trim().min(1),
    /**
     * Build again rather than deploy what is already built.
     *
     * Absent is the one-button decision unchanged, so every existing caller
     * keeps its behaviour by saying nothing. Set only where the operator asked
     * for a Build in as many words.
     */
    rebuild: z.boolean().optional(),
    /**
     * The commit this act is about, for a caller that has one.
     *
     * §15's dispatcher does; the workspace button does not, and that is the
     * whole difference between them. A press means "deploy what is built" and
     * carries no commit to disagree with. A push means "this commit", so an App
     * whose newest Build succeeded at the *previous* commit is not deployable
     * for this caller — it needs the second act, which is what `rebuild` names
     * when an operator asks for it in as many words.
     *
     * Absent is every existing caller unchanged. Set, it is a fact this command
     * decides *which act* against — never a second admission policy, and never
     * a bypass of `checkDeployable`/`placeIntent`.
     */
    commit: z.string().trim().min(1).optional(),
    /**
     * The Component to act on, by its name or id within this App.
     *
     * Absent means the App's primary component (`components[0]`), so every
     * existing caller keeps its behaviour by saying nothing. An App with more
     * than one Component — a `job` alongside its `service`, say — has no other
     * way to reach the rest: nothing else inserts a Build for them.
     */
    component: z.string().trim().min(1).optional(),
    /**
     * The Target for a Component deploying for the first time — its id, or the
     * two facts that identify it spelled `<vessel>/<adapter>`.
     *
     * Only a first deploy needs it: placement is a fact `placeComponent` or a
     * first deploy writes, so a Component that has done neither has none to
     * read back. Absent, the Component's own placement answers as it always
     * has, and a value that disagrees with it is refused rather than silently
     * moving the Component — moves go through `placeComponent`.
     */
    target: z.string().trim().min(1).optional(),
  })
  .strict();

export type DeployAppInput = z.infer<typeof deployAppInput>;

/**
 * What a *caller over HTTP* may say — the same command, minus `commit`.
 *
 * §15: only the default branch is authoritative, and the one thing that decides
 * which commit is authoritative is a reconciliation pass. `commit` exists so
 * that pass can tell this command what it adopted; a browser naming one would
 * be asking Spindrift to stage, build and place an arbitrary ref — an unmerged
 * branch, a fork's head — through a path with no review and no admission gate
 * of its own. The schema is `.strict()`, so a request carrying `commit` is
 * refused outright rather than quietly ignored.
 *
 * This is the registered schema; {@link deployAppInput} stays the in-process
 * one, and §15's dispatcher calls the handler directly.
 */
export const deployAppRequestInput = deployAppInput.omit({ commit: true });

export interface DeployAppResult {
  /**
   * The intent that was written, or `null` when a Build had to start first.
   *
   * `null` is not a failure — it is the difference between "this is going live"
   * and "this is being built", and the screen sends the operator somewhere
   * different for each.
   */
  readonly deployId: number | null;
  /** The Build this act is about: the one being deployed, or the one started. */
  readonly buildId: number;
  /**
   * `PENDING` for a written intent, `BUILDING` when only a Build was started,
   * `UNCHANGED` when this commit is already what is desired here and nothing
   * was written at all.
   *
   * `UNCHANGED` is reachable only for a caller that named a {@link
   * DeployAppInput.commit} — the button cannot produce it, because a press with
   * nothing new to say is still an operator asking for a re-apply.
   */
  readonly phase: 'PENDING' | 'BUILDING' | 'UNCHANGED';
}

/** What a rerun's new Build records about the source it will be built from. */
interface RerunSource {
  /** The commit the Build names, before the rerun suffix is appended. */
  readonly commit: string;
  readonly bundleDigest: string | null;
  readonly bundleLocation: string | null;
  /** What staging (or the inherited row) knew of the commit beyond its sha. */
  readonly headline: CommitHeadline | null;
}

/**
 * Stage the bundle the new Build will be dispatched from (§15).
 *
 * **A Build inherits a bundle only while that bundle is still fetchable and
 * still names the commit the repository is at.** Copying the previous Build's
 * `bundleLocation` forward unconditionally would carry an unfetchable handle —
 * an `upload://` from an installation with no depot — into a Build that then
 * dies at `curl` naming a download rather than the staging that never happened;
 * and where it *was* fetchable it made a rerun mean "the same commit, forever",
 * which is not what anyone presses Rebuild for after a push.
 *
 * **Why here and not at dispatch.** §15 has Spindrift "fetch the exact commit
 * *once* and stage an immutable source bundle for either builder", and the
 * thing a bundle is staged *for* is a Build. Dispatch runs more than once per
 * Build — a lease expires, a route is retried — so staging there would fetch
 * per attempt rather than per Build, and would let a Build's own identity, the
 * bundle digest §16 joins provenance on, change underneath a run in flight.
 * Creating the Build is the one moment that happens once, which is why
 * `completeCreationDraft` already stages there and why this path is the
 * anomaly rather than the precedent.
 *
 * Re-staging is cheap to repeat: the depot is content-addressed, so the same
 * commit yields the same bytes, the same digest, and the same object.
 *
 * The refusals are refusals rather than a Build written anyway, because a Build
 * with a bundle nothing can fetch is a dispatch, a runner, and a CI log spent
 * to tell the operator something that was knowable before the button was
 * pressed.
 */
async function sourceForRerun(
  app: Pick<
    typeof apps.$inferSelect,
    'name' | 'sourceKind' | 'sourceArchiveDigest' | 'repositoryId'
  >,
  /** Whose Build this is, because an archive's bytes are held per Component. */
  componentName: string,
  previous: Pick<
    typeof builds.$inferSelect,
    | 'commit'
    | 'bundleDigest'
    | 'bundleLocation'
    | 'commitMessage'
    | 'commitAuthor'
    | 'commitAuthoredAt'
  > | null,
  /**
   * The commit the caller's act is about, where it named one.
   *
   * §15's dispatcher decides *which act* against a commit, so the Build that
   * act writes has to be of that same commit — otherwise the decision and the
   * artifact disagree, which is the defect this whole path exists to fix one
   * layer up. `null` is every other caller, which asks the repository.
   */
  requested: string | null,
  context: Pick<CommandContext, 'db' | 'adapters' | 'clock'>,
): Promise<CommandResult<RerunSource>> {
  // `builds_component_commit_shape_unique` makes a rerun collide with the
  // attempt it is rerunning, which is why the rows carry a `#<millis>` suffix.
  // It is a uniqueness device, not part of the commit, so it never travels into
  // staging.
  const baseCommit = (previous?.commit ?? 'HEAD').split('#')[0] || 'HEAD';
  const inheritedDigest =
    previous?.bundleDigest ?? app.sourceArchiveDigest ?? null;
  const inherited = previous?.bundleLocation ?? null;

  // **A repo App's rerun follows its repository, not its own last Build.** The
  // commit to build is `repositories.authoritative_commit` — the one §15's loop
  // adopted from the default branch — and the predecessor's only when there is
  // no repository to ask. Deciding it from `previous.commit` and inheriting any
  // still-fetchable bundle pinned every Build after the first to the commit the
  // App was created at: a push moved `authoritative_commit`, nothing staged it,
  // and Rebuild rebuilt bytes from weeks ago while reporting success. Config
  // adoption is what this reads rather than the branch head, so source and the
  // Spindrift file a Build is governed by stay the same commit.
  const [repository] =
    app.sourceKind === 'repo' && app.repositoryId !== null
      ? await context.db
          .select()
          .from(repositories)
          .where(eq(repositories.id, app.repositoryId))
          .limit(1)
      : [];
  const wanted =
    requested ??
    (repository?.access === 'active'
      ? (repository.authoritativeCommit ?? baseCommit)
      : baseCommit);

  if (
    wanted === baseCommit &&
    inherited !== null &&
    isFetchableBundleLocation(inherited) &&
    // An *ephemeral* bundle is not inherited, because the depot is allowed to
    // have expired it since the Build it was staged for — a Build carrying a
    // location nothing can fetch dies at `curl`, which is this function's
    // founding defect wearing a new scheme. Staging again is the safe form of
    // the same reuse: canonical bytes mean the same commit digests to the same
    // object, and the overwrite resets the object's lifecycle clock.
    !isEphemeralBundleLocation(inherited)
  ) {
    // A durable bundle to reuse: a `gs://` object is immutable and shared, so
    // the same commit wants the same one. A *repo* Component with no bundle
    // falls through instead — its first Build is exactly the "stage the exact
    // commit once" act, rather than a Build nothing can dispatch.
    return ok({
      commit: baseCommit,
      bundleDigest: inheritedDigest,
      bundleLocation: inherited,
      // The same commit, so the same headline: what the inherited row kept.
      headline:
        previous === null
          ? null
          : {
              message: previous.commitMessage,
              author: previous.commitAuthor,
              authoredAt: previous.commitAuthoredAt,
            },
    });
  }

  if (app.sourceKind !== 'repo') {
    // §15: "repo bundles are ephemeral, archives durable." An archive's bytes
    // only ever existed as what a developer uploaded, so there is nothing to
    // fetch again and no honest way to produce this bundle a second time.
    //
    // The second sentence is for a Component that never had one at all, which
    // this command used to answer with `ok` and a null location — correct while
    // an archive App could only ever have the one Component the create flow
    // staged bytes for, and wrong the moment the Components card could add a
    // second (ticket 118). What it produced was a PENDING Build that
    // `dispatchBuild` closes on sight (`src/commands/builds/dispatch.ts:524`):
    // a dispatch, a lease and a dead row, spent telling the operator something
    // that was knowable before the press. So it is refused here, naming the two
    // acts that would give this Component an artifact — its own uploaded
    // bundle, or the one a sibling already built.
    return failed(
      'NOT_BUILDABLE',
      inherited === null
        ? `${app.name} is deployed from an uploaded archive and '${componentName}' has no bundle of its own, so there is nothing to build for it — upload an archive for this Component, or adopt the artifact a sibling Component already built`
        : `${app.name}'s uploaded archive was staged at ${inherited}, which no build route can fetch, and an archive cannot be staged again from anything Spindrift holds — upload it again to stage it in the depot`,
    );
  }

  // On this path `inherited` is a stale unfetchable handle, nothing at all for
  // a Component's first Build, or a perfectly good bundle for a commit the
  // repository has moved past. The refusals below say which.
  const was =
    wanted !== baseCommit
      ? `staged at ${baseCommit}, which ${wanted} has moved past`
      : inherited === null
        ? 'never staged for this Component'
        : `staged at ${inherited}, which no build route can fetch`;

  const stager = context.adapters.source?.() ?? null;
  if (stager === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and this installation configures no source depot to stage a fresh one into`,
    );
  }

  if (repository === undefined) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${app.name} has no connected repository to stage a fresh one from — connect its repository to make it buildable`,
    );
  }
  if (repository.access !== 'active') {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${repository.fullName} is ${repository.access}, so no fresh bundle can be staged: ${repository.frozenReason ?? 'access to it was lost'}`,
    );
  }

  // `HEAD` is this command's own placeholder for "no previous Build named a
  // commit", and it is not a commit anyone can be asked to fetch exactly. The
  // repository's authoritative commit is (§15: only a default-branch merge push
  // becomes authoritative).
  const commit = wanted === 'HEAD' ? repository.authoritativeCommit : wanted;
  if (commit === null) {
    return failed(
      'NOT_BUILDABLE',
      `${app.name}'s bundle was ${was}, and ${repository.fullName} has no authoritative commit ready to stage a fresh one from`,
    );
  }

  try {
    const staged = await stager.stageRepository({
      ref: repositoryRefOf(repository),
      repository: repository.fullName,
      commit,
      stagedAt: context.clock.now(),
    });
    return ok({
      commit,
      bundleDigest: staged.digest,
      bundleLocation: staged.location,
      headline: staged.commit ?? null,
    });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return failed(
      'NOT_BUILDABLE',
      `could not stage ${repository.fullName} at ${commit} to replace ${app.name}'s unfetchable bundle: ${detail}`,
    );
  }
}

export const deployApp: Command<DeployAppInput, DeployAppResult> = async (
  input,
  context,
) => {
  // `apps` carries no unique constraint on `name` — `components` has
  // `unique(appId, name)` and `targets` has `unique(name)`, `apps` has neither —
  // so a name is not an identifier and `findFirst` on one silently picks a row.
  // Reading every match instead makes the ambiguity sayable: a name two Apps
  // answer to is refused with both ids rather than acted on, which is §3's
  // listed-and-annotated grammar rather than a coin flip on live infrastructure.
  const isUuid = z.uuid().safeParse(input.name).success;
  const matches = await context.db.query.apps.findMany({
    where: (appsTable, { eq: eqOp, or: orOp }) =>
      isUuid
        ? orOp(eqOp(appsTable.name, input.name), eqOp(appsTable.id, input.name))
        : eqOp(appsTable.name, input.name),
    with: {
      components: {
        // Oldest first, the same order `getAppWorkspace` reads them in: "the
        // App's first Component" is what a deploy that names none acts on and
        // what the screen shows by default, and an unordered read makes those
        // two the same sentence about different Components.
        orderBy: (componentsTable, { asc }) => [asc(componentsTable.createdAt)],
        with: {
          builds: {
            // `id` breaks the tie. Two Builds can share a `createdAt` — the
            // column is written from the command's own clock, not the
            // database's — and "the newest Build" is what every act below
            // keys on, so an ambiguous answer picks a different Build on
            // different reads of the same rows.
            orderBy: (buildsTable, { desc }) => [
              desc(buildsTable.createdAt),
              desc(buildsTable.id),
            ],
            limit: 1,
          },
        },
      },
    },
  });

  if (matches.length === 0) {
    return failed('NOT_FOUND', `App '${input.name}' not found`);
  }

  if (matches.length > 1) {
    return failed(
      'INVALID_INPUT',
      `${matches.length} Apps answer to '${input.name}', so this would deploy an arbitrary one — deploy by id: ${matches
        .map((candidate) => candidate.id)
        .join(', ')}`,
      [{ path: 'name', message: 'names more than one App' }],
    );
  }

  const app = matches[0]!;

  const primaryComponent = app.components[0];
  if (!primaryComponent) {
    return failed('NOT_FOUND', `App '${app.name}' has no components to deploy`);
  }

  let component = primaryComponent;
  if (input.component !== undefined) {
    const named = app.components.find(
      (candidate) =>
        candidate.id === input.component || candidate.name === input.component,
    );
    if (!named) {
      const names = app.components
        .map((candidate) => candidate.name)
        .join(', ');
      return failed(
        'NOT_FOUND',
        `App '${app.name}' has no Component '${input.component}' — it has: ${names}`,
      );
    }
    component = named;
  }

  // The placement of record, read off the Component itself: the one fact
  // `placeComponent` moves, a first placement establishes, and
  // `unplaceComponent` clears. Nothing here infers it from desired rows or
  // deploy history — an unplaced Component is unplaced, whatever once served.
  const placedTargetId = component.placedTargetId ?? undefined;

  let targetId = placedTargetId;
  if (input.target !== undefined) {
    // Either an id, or the `<vessel>/<adapter>` spelling split back into the
    // two facts it states. Anything else resolves nothing, which is the honest
    // answer — half an identity does not name a Target.
    const [vessel, surface] = input.target.split('/');
    const adapter = targetAdapterSchema.safeParse(surface);
    const identifies = z.uuid().safeParse(input.target).success
      ? eq(targets.id, input.target)
      : vessel !== undefined && adapter.success
        ? and(eq(vessels.name, vessel), eq(targets.adapter, adapter.data))
        : null;
    const [named] =
      identifies === null
        ? []
        : await context.db
            .select({ id: targets.id })
            .from(targets)
            .innerJoin(vessels, eq(targets.vesselId, vessels.id))
            .where(identifies);
    if (named === undefined) {
      return failed('NOT_FOUND', `there is no Target '${input.target}'`);
    }
    // Placement wins where it exists: a deploy that named a different Target
    // than the one this Component lives on is a move, and moves go through
    // `placeComponent` — not through a deploy that quietly lands somewhere new.
    if (placedTargetId !== undefined && placedTargetId !== named.id) {
      return failed(
        'INVALID_INPUT',
        `Component '${component.name}' is placed elsewhere — deploy without ` +
          'naming a Target, or move it first',
        [{ path: 'target', message: 'disagrees with the existing placement' }],
      );
    }
    targetId = named.id;
  }

  if (!targetId) {
    return failed(
      'NOT_FOUND',
      `Component '${component.name}' has no target placement — name one: ` +
        'a first deploy is what writes it',
    );
  }

  const latestBuild = component.builds[0];

  // A rerun row is keyed `<commit>#<millis>` (see the insert below) because
  // `builds_component_commit_shape_unique` would otherwise make a rerun collide
  // with the attempt it reruns. The suffix is a uniqueness device and never part
  // of the commit, so every comparison against one strips it — the same reading
  // `sourceForRerun` takes.
  const builtCommit =
    latestBuild === undefined
      ? null
      : (latestBuild.commit.split('#')[0] ?? latestBuild.commit);
  const isRequestedCommit =
    input.commit === undefined || builtCommit === input.commit;

  if (
    !input.rebuild &&
    // The newest Build has to be *of this commit* for a caller that named one.
    // Without this, a push to a healthy App took the deployable branch and
    // placed a Deploy of the artifact built from the previous commit: the
    // pushed commit was adopted and then never built at all.
    isRequestedCommit &&
    latestBuild &&
    latestBuild.status === 'SUCCEEDED' &&
    latestBuild.artifactDigest !== null
  ) {
    if (input.commit !== undefined) {
      // This commit is already what is desired on this pair, so there is
      // nothing for a push to cause. Writing the intent anyway is a Deploy row
      // and a full re-apply of a byte-identical artifact — free on Kubernetes,
      // another production deployment on Vercel. Reached whenever an App is
      // created from the commit the loop is about to adopt for the first time.
      const [desired] = await context.db
        .select({
          desiredBuildId: componentTargetDesired.desiredBuildId,
          desiredDeployId: componentTargetDesired.desiredDeployId,
        })
        .from(componentTargetDesired)
        .where(
          and(
            eq(componentTargetDesired.componentId, component.id),
            eq(componentTargetDesired.targetId, targetId),
          ),
        )
        .limit(1);
      if (desired?.desiredBuildId === latestBuild.id) {
        return ok({
          deployId: desired.desiredDeployId,
          buildId: latestBuild.id,
          phase: 'UNCHANGED' as const,
        });
      }
    }

    const deployAttempt = await createDeploy(
      {
        componentId: component.id,
        targetId,
        buildId: latestBuild.id,
      },
      context,
    );

    // The refusal travels out exactly as `createDeploy` wrote it. Anything else
    // here would be a second admission policy, and there is only supposed to be
    // one.
    if (!deployAttempt.ok) return deployAttempt;

    return ok({
      deployId: deployAttempt.value.deployId,
      buildId: latestBuild.id,
      phase: 'PENDING' as const,
    });
  }

  const now = context.clock.now();
  const leaseCutoff = new Date(now.getTime() - DISPATCH_LEASE_TIMEOUT_MS);
  let buildToRun = latestBuild;

  /**
   * Whether a Build is genuinely in flight, as opposed to merely not finished.
   *
   * `RUNNING` past its lease is a runner that died: `runBuildPass` selects only
   * `PENDING` rows, so nothing sweeps it, and the reset below is the only thing
   * that puts it back in the queue. Treating it as in-flight would strand that
   * commit for good.
   */
  const inFlight =
    buildToRun !== undefined &&
    (buildToRun.status === 'PENDING' ||
      (buildToRun.status === 'RUNNING' &&
        buildToRun.leasedAt !== null &&
        buildToRun.leasedAt >= leaseCutoff));

  // A Build of this very commit is already in flight, so the push it came from
  // has already caused everything it is going to cause. Falling through would
  // reset a Build that is fine — and, where it is `RUNNING`, revoke a live
  // attempt's lease.
  if (input.commit !== undefined && isRequestedCommit && inFlight) {
    return ok({
      deployId: null,
      buildId: buildToRun!.id,
      phase: 'BUILDING' as const,
    });
  }

  if (
    !buildToRun ||
    buildToRun.status === 'FAILED' ||
    buildToRun.status === 'SUCCEEDED' ||
    // A caller that named a commit and did not find it built needs a Build of
    // *that* commit. The reset arm below cannot produce one: it re-dispatches
    // the existing row, whose bundle was staged for the commit it already
    // names — so a push arriving while an older commit was still queued would
    // rebuild the older commit and report success.
    !isRequestedCommit
  ) {
    // §3: shape follows the Target, not the predecessor. A rebuild is the
    // remediation the cross-shape refusal prescribes — "this placement needs
    // a rebuild" — so the new Build derives its shape from the Target this
    // Component is placed on, the same derivation `createDeploy` admits with
    // and `completeCreationDraft` creates with. Inheriting the predecessor's
    // shape instead reruns it forever, and the Build that refusal asks for
    // never becomes reachable.
    const placedOn = targetId;
    const target = await context.db.query.targets.findFirst({
      where: (targetsTable, { eq: eqOp }) => eqOp(targetsTable.id, placedOn),
      with: { vessel: true },
    });
    if (target === undefined) {
      return failed('NOT_FOUND', `there is no Target with id ${targetId}`);
    }
    const shape = artifactTypeFor(
      component.kind,
      placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      }),
    );

    // The bundle is staged before the row exists, so what the row records is
    // this Build's own source rather than the last one's. A refusal here is
    // returned unchanged, the same way `createDeploy`'s is: it names the App and
    // what would make it buildable, which is worth more than a Build nothing can
    // dispatch.
    const rerun = await sourceForRerun(
      app,
      component.name,
      buildToRun ?? null,
      input.commit ?? null,
      context,
    );
    if (!rerun.ok) return rerun;

    // `builds_component_commit_shape_unique` makes a rerun of the same commit
    // collide with the attempt it is rerunning, so it becomes a new row keyed by
    // when it was asked for.
    const commitRef = `${rerun.value.commit}#${now.getTime()}`;

    const [newBuild] = await context.db
      .insert(builds)
      .values({
        componentId: component.id,
        commit: commitRef,
        targetShape: shape,
        artifactType: shape,
        bundleDigest: rerun.value.bundleDigest,
        bundleLocation: rerun.value.bundleLocation,
        commitMessage: rerun.value.headline?.message ?? null,
        commitAuthor: rerun.value.headline?.author ?? null,
        commitAuthoredAt: rerun.value.headline?.authoredAt ?? null,
        // A repo Build's subpath is the App's declared subpath, never an
        // inheritance: the bundle is the staged source root, '.' would build
        // the monorepo's root instead of the App, and a predecessor row that
        // recorded '.' (a Build created before its Component could stage)
        // must not pass that lie forward. Archive lineage keeps the uploaded
        // bundle's own subpath — its bytes carry their own layout.
        bundleSubpath:
          app.sourceKind === 'repo'
            ? (app.sourceRepoSubpath ?? '.')
            : (buildToRun?.bundleSubpath ?? '.'),
        status: 'PENDING',
        createdAt: now,
        // What a push asked for, recorded where it survives the wait. See the
        // column's own note: the build loop reads it when the verdict lands,
        // by which time this caller is long gone.
        deployOnSuccess: input.commit !== undefined,
      })
      .returning();

    buildToRun = newBuild;
  } else {
    // `RUNNING` under a live lease is a generator streaming into this attempt's
    // log right now. Nulling `dispatchId` and `leasedAt` under it does not stop
    // it — nothing here can — it only makes the build loop dispatch a second
    // one on its next 500ms tick, so two generators write one attempt log and
    // whichever finishes last lands the verdict. Refused rather than cancelled
    // because there is no cancel to offer: the route's own terminal write is
    // what ends an attempt, and the lease expiring is what makes this row
    // reclaimable, which is the wait this sentence names.
    //
    // **The condition is the `WHERE`, not a check above it.** `buildToRun` was
    // read at the top of this command, several awaits and a network staging
    // ago, and `dispatchBuild` claims rows concurrently by design — so a claim
    // that lands in that window would pass any in-memory guard and then be
    // clobbered by an unconditional update. Matching zero rows *is* the
    // refusal.
    const rearmed = await context.db
      .update(builds)
      .set({
        status: 'PENDING',
        runner: null,
        logFidelity: null,
        dispatchId: null,
        leasedAt: null,
        // A fresh press resets the backoff clock (story 101): the operator
        // asked for this Build *now*, and holding it to a wait earned by
        // refusals they may have just fixed would read as a dead button.
        dispatchAttempts: 0,
        nextDispatchAt: null,
        // `deployOnSuccess` is deliberately **not** cleared. Re-arming a Build
        // a push asked for does not change what was asked for — the operator
        // re-queued that Build, they did not replace it — and clearing it here
        // would make a Rebuild press silently cancel the push's deploy, which
        // is a worse surprise than the one this arm was hardened against.
      })
      .where(
        and(
          eq(builds.id, buildToRun.id),
          or(
            eq(builds.status, 'PENDING'),
            and(
              eq(builds.status, 'RUNNING'),
              or(isNull(builds.leasedAt), lt(builds.leasedAt, leaseCutoff)),
            ),
          ),
        ),
      )
      .returning({ id: builds.id });

    if (rearmed.length === 0) {
      return failed(
        'NOT_BUILDABLE',
        `Build ${buildToRun.id} for '${component.name}' is already running — ` +
          'wait for it to finish, or for its lease to expire, before starting ' +
          'another',
      );
    }
  }

  // The desired row, and nothing on it. `runBuildPass` dispatches a Build
  // against the Target its Component is placed on, and `dispatchBuild` checks
  // that placement names a desired row — so a Build with no such row is one no
  // loop can run. `desiredBuildId` and `desiredDeployId` stay untouched: those
  // say what should be *live* here, and only an intent written under §6's lock
  // gets to answer that.
  await context.db
    .insert(componentTargetDesired)
    .values({
      componentId: component.id,
      targetId,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // A first deploy of an unplaced Component establishes its placement of
  // record, exactly as `placeIntent` does on the deployable branch.
  // Conditional on NULL, so a Build staged for an already-placed Component
  // never moves it.
  await context.db
    .update(components)
    .set({ placedTargetId: targetId })
    .where(
      and(eq(components.id, component.id), isNull(components.placedTargetId)),
    );

  return ok({
    deployId: null,
    buildId: buildToRun!.id,
    phase: 'BUILDING' as const,
  });
};
