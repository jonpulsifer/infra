/**
 * `adoptBuild`: copies a sibling Component's succeeded Build, provenance and
 * registry address included, so a Component runs that artifact without a
 * rebuild. Both Components must be in one App, which carries the source.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { builds, components } from '../../db/schema.ts';
import { type Command, failed, ok } from '../types.ts';

export const adoptBuildInput = z
  .object({
    /** The Component that will run the artifact. */
    componentId: z.uuid(),
    /** The sibling's Build whose artifact is being adopted. */
    fromBuildId: z.number().int().positive(),
  })
  .strict();

export type AdoptBuildInput = z.infer<typeof adoptBuildInput>;

export interface AdoptBuildResult {
  /** The adopter's own Build, which a Deploy may now name. */
  readonly buildId: number;
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

  // With the Component, whose App decides whether adoption is allowed.
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
    return failed(
      'INVALID_INPUT',
      `Build ${source.id} belongs to Component ${source.component.id}, which is in a different App than Component ${component.id} — an artifact can only be adopted within one App`,
      [{ path: 'fromBuildId', message: 'a Build of another App' }],
    );
  }

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
      // A copy: `createDeploy` refuses another Component's Build. The commit
      // is kept too, so the row joins to the source it ran.
      commit: source.commit,
      commitMessage: source.commitMessage,
      commitAuthor: source.commitAuthor,
      commitAuthoredAt: source.commitAuthoredAt,
      targetShape: source.targetShape,
      artifactType: source.artifactType,
      artifactDigest,
      artifactRefs: source.artifactRefs,
      bundleDigest: source.bundleDigest,
      bundleLocation: source.bundleLocation,
      bundleSubpath: source.bundleSubpath,
      status: 'SUCCEEDED',
      // Same digest, same attestation; `checkDeployable` re-checks both at
      // the destination.
      verifiedBuildLevel: source.verifiedBuildLevel,
      signature: source.signature,
      provenance: source.provenance,
      // Carried: a null runner on a succeeded Build marks a supplied artifact,
      // so nulling it would misfile a built one.
      runner: source.runner,
      // Execution columns such as `runUrl` and `dispatchId` stay on the source.
      createdAt: context.clock.now(),
    })
    // A repeat adoption hits the key the first one wrote. Never overwrite: a
    // Deploy may already name that row.
    .onConflictDoNothing()
    .returning();

  if (row !== undefined) return ok({ buildId: row.id, artifactDigest });

  // Something holds this key. The same digest is a repeat adoption; another is
  // this Component's own Build of that commit, refused so it is not retargeted.
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
