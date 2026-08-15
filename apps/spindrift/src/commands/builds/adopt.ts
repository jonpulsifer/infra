/**
 * `adoptBuild` — a Component runs an artifact a sibling Component of the same
 * App already produced, without building it a second time (§2, §4, §16).
 *
 * The monolith case: `web` builds the image, `worker` and `cleanup` run it under
 * their own commands. That needs no new noun, because **there is no artifacts
 * table** — an Artifact is a `builds` row with a non-null `artifactDigest`
 * (`src/commands/artifacts/list.ts:76-77`), which is §2's "Source and Artifact
 * are derived, not stored" read literally. So adopting one is inserting a
 * `builds` row that names the same digest for a different Component, and that is
 * the shape `uploadArchive`'s supplied arm already writes
 * (`src/commands/apps/upload-archive.ts:132-171`): a pre-digested Build born
 * `SUCCEEDED` with no adapter looked up. This is a third caller of it.
 *
 * **A copy, not a pointer.** `createDeploy` refuses a Build belonging to another
 * Component (`src/commands/deploys/create.ts:370-375`) and that guard stays
 * untouched — a Deploy names a Build, a Build names a Component, and the
 * reconciler joins straight through both
 * (`src/reconciler/deploy-loop.ts:643-660`). Letting one Component's Deploy point
 * at another's Build makes that chain stop meaning anything; copying the row
 * keeps every link in it true. Which is also why the reconciler needs *zero*
 * changes: `desiredStateFor` reads `artifactType` / `artifactDigest` /
 * `artifactRefs` (`src/reconciler/deploy-loop.ts:305-309`) and never asks who
 * produced them.
 *
 * **The provenance columns are copied, and that is honest rather than a
 * loophole.** `checkDeployable` re-verifies the recorded signature against the
 * recorded digest and compares `verifiedBuildLevel` with the Target's policy
 * (`src/commands/deploys/create.ts:400-431`). An attestation is a statement about
 * a digest, and this is the same digest — dropping them would only make the
 * adopted Build undeployable anywhere with a policy, which is a worse lie than
 * carrying them. Both gates then re-run in full at the destination, so a Target
 * with a *higher* threshold than the source's still refuses.
 *
 * **The registry path stays the source's.** `artifactRefs` reads
 * `{registry}/{app}/{sourceComponent}` (`src/domain/artifact-name.ts:77-92`), so
 * the adopter's image lives under its sibling's repository. That address is real
 * and pullable, and `artifactAddress` / `pullableFrom`
 * (`src/domain/desired-state.ts:83-113`) work on any address the Target reaches.
 * Re-pushing under the adopter's own path is refused for the reason
 * `src/domain/source.ts:82-90` already gives — it "would need a registry push
 * core does not do and a digest core did not compute". One digest at one address
 * is the honest statement of what sharing is.
 *
 * **Same App only.** Decided 2026-08-12. The App is what carries the source
 * (`apps.sourceRepoUrl` / `sourceRepoSubpath`, `src/db/schema.ts:466-468`), so an
 * artifact adopted from outside it has a lineage no App can be asked about, and
 * the Artifacts ledger becomes a registry. The monolith case is one App by
 * construction, so the restriction costs nothing it was for.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { builds, components } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';

export const adoptBuildInput = z
  .object({
    /** The Component that will run the artifact — the adopter. */
    componentId: z.uuid(),
    /** The sibling's Build whose artifact is being adopted. */
    fromBuildId: z.number().int().positive(),
  })
  .strict();

export type AdoptBuildInput = z.infer<typeof adoptBuildInput>;

export interface AdoptBuildResult {
  /** The adopter's own Build, which is what a Deploy may now name. */
  readonly buildId: number;
  /** The one digest both Builds describe, echoed so a caller can correlate. */
  readonly artifactDigest: string;
}

export const adoptBuild: Command<AdoptBuildInput, AdoptBuildResult> = async (
  input,
  context,
) => {
  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (component === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  // With the Component, because the App is the half of the source that decides
  // whether this adoption is allowed at all.
  const source = await context.db.query.builds.findFirst({
    where: (build, { eq: eqOp }) => eqOp(build.id, input.fromBuildId),
    with: { component: true },
  });
  if (source === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Build with id ${input.fromBuildId}`,
    );
  }

  if (source.component.appId !== component.appId) {
    // By id, both of them: the operator picked a Build out of a list and the
    // only useful sentence names the two things that disagree.
    return failed(
      'INVALID_INPUT',
      `Build ${source.id} belongs to Component ${source.component.id}, which is in a different App than Component ${component.id} — an artifact can only be adopted within one App`,
      [{ path: 'fromBuildId', message: 'a Build of another App' }],
    );
  }

  // §4: "a build records an artifact rather than deploying one." A Build that has
  // not succeeded has no artifact to adopt, which is the same fact
  // `checkDeployable` refuses a placement with, said in the same sentence.
  if (source.status !== 'SUCCEEDED' || source.artifactDigest === null) {
    return failed(
      'NOT_DEPLOYABLE',
      `Build ${source.id} has no artifact — it is ${source.status.toLowerCase()}`,
    );
  }

  const artifactDigest = source.artifactDigest;

  const [row] = await context.db
    .insert(builds)
    .values({
      componentId: component.id,
      // Everything below is the source Build's, unchanged. The commit included:
      // §2 keys a Build on (component, commit, target-shape) and the commit is
      // the input this artifact came out of — rewriting it here would make the
      // adopter's ledger row unjoinable to the source it actually ran.
      commit: source.commit,
      targetShape: source.targetShape,
      artifactType: source.artifactType,
      artifactDigest,
      artifactRefs: source.artifactRefs,
      bundleDigest: source.bundleDigest,
      bundleLocation: source.bundleLocation,
      bundleSubpath: source.bundleSubpath,
      status: 'SUCCEEDED',
      verifiedBuildLevel: source.verifiedBuildLevel,
      signature: source.signature,
      provenance: source.provenance,
      // Carried, not nulled. `artifacts/list.ts:114` reads a null runner on a
      // SUCCEEDED Build as §4's *supplied* artifact — uploaded finished output no
      // builder ran over — and `builds/view.ts:45-51` reads the same pair to
      // decide whether there is a build to project at all. Nulling it here would
      // file a built artifact under "nobody built this", which is a claim about
      // provenance and not a cosmetic one. The runner named it produced these
      // bytes; this row describes those bytes; so it is the true answer. An
      // adopted *supplied* artifact carries the null forward for the same reason
      // and stays supplied, which it is.
      runner: source.runner,
      // Deliberately not carried: `runUrl`, `logFidelity`, `dispatchId`,
      // `leasedAt` and the attempt events address one execution on one backend.
      // This row is not that execution — the source Build is, and it is still in
      // the ledger with all of it attached.
      createdAt: context.clock.now(),
    })
    // §2's key is (component, commit, target-shape), so adopting twice lands on
    // the row the first adoption wrote. There is nothing new to write for it, and
    // writing anyway is how a re-adoption blanks the refs of a Build something is
    // already deployed from — the argument `uploadArchive` makes at
    // `src/commands/apps/upload-archive.ts:160-164`, for the same key.
    .onConflictDoNothing()
    .returning();

  if (row !== undefined) return ok({ buildId: row.id, artifactDigest });

  // `DO NOTHING` wrote nothing, so something already holds this key. Which of the
  // two things it is decides the answer, and only the digest can tell them apart:
  //
  // - **The same artifact** — this adoption already happened (or the caller named
  //   this Component's own Build). Answering with it is idempotent and true.
  // - **A different one** — this Component built that commit itself, or is
  //   building it right now. Two digests for one commit is not a contradiction
  //   — bases move, timestamps differ, a rotated build secret rebuilds
  //   differently (story 112); the digest is the artifact's identity and the
  //   commit is not. What stays out of the question is overwriting: it would
  //   blank a Build in flight, or retarget one a Deploy names. And answering
  //   with the row would hand back an artifact that was not the one asked for.
  //   So it is refused, naming the row in the way.
  const [existing] = await context.db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.componentId, component.id),
        eq(builds.commit, source.commit),
        eq(builds.targetShape, source.targetShape),
      ),
    );
  if (existing === undefined) {
    return failed(
      'NOT_FOUND',
      'the adopted Build could not be read back after writing it',
    );
  }
  if (existing.artifactDigest !== artifactDigest) {
    return failed(
      'INVALID_INPUT',
      `${component.name} already has Build ${existing.id} for commit ${source.commit} as ${source.targetShape}, carrying a different artifact — not a contradiction, but a row a Deploy may name, so it is not retargeted`,
      [{ path: 'componentId', message: 'already has a Build for that commit' }],
    );
  }
  return ok({ buildId: existing.id, artifactDigest });
};
