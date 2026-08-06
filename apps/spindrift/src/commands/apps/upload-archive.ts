/**
 * `uploadArchive` — an App whose source arrived as bytes rather than a repo
 * (§4, §5, §15).
 *
 * §4: "Repo and archive share **one pipeline** — unpack, detect, build. An
 * archive of *finished output* is a supplied artifact, digested over the
 * uploaded bundle; an archive of *source* builds normally."
 *
 * Both arms end at the same place — **a Build row carrying a digest** — and that
 * is the point of this command. What differs is only whether a builder is
 * involved on the way there:
 *
 * - **Finished output** is recorded, not built. The Build is born `SUCCEEDED`
 *   with the bundle digest standing as the artifact digest, and no build adapter
 *   is looked up, let alone invoked. There is nothing for a builder to do: the
 *   artifact already exists and core digested it.
 * - **Source** is staged and left `PENDING` for `dispatchBuild` to run through
 *   the identical ladder a repo takes. This command does not run it, because
 *   §4's pipeline is one pipeline and a second entry point into it would be a
 *   second pipeline wearing its name.
 *
 * **This command never reads the bundle.** It is handed a digest and a location
 * by whatever received the upload, because the digest is §16's join between the
 * source receipt and the provenance document — it must be computed over exactly
 * the bytes that were staged, and the only thing that saw those is the thing
 * that staged them.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { builds, components } from '../../db/schema.ts';
import type { ArtifactType } from '../../domain/desired-state.ts';
import { digestSchema } from '../../domain/digest.ts';
import { artifactTypeFor, placementTargetOf } from '../../domain/placement.ts';
import {
  type ArchiveSource,
  commitOf,
  isSuppliedArtifact,
  SUPPLIED_ARTIFACT_TYPE,
} from '../../domain/source.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

/** A content digest over the staged bundle (§16). */
const bundleDigest = digestSchema;

export const uploadArchiveInput = z
  .object({
    componentId: z.uuid(),
    /**
     * Which Target this upload is destined for. Required because §3 puts
     * resolution **before** the build and has it output "placement plus artifact
     * shape" — a Build's key includes the shape, so there is no shape-agnostic
     * Build row to write first and decide about later.
     */
    targetId: z.uuid(),
    bundleDigest,
    /** Where the staged bundle is fetched from. */
    location: z.string().trim().min(1),
    /** §4's two arms. See {@link ArchiveContents}. */
    contents: z.enum(['artifact', 'source']),
    /** §5's scope, after a lone top-level directory has been unwrapped. */
    subpath: z.string().trim().min(1).default('.'),
  })
  .strict();

export type UploadArchiveInput = z.infer<typeof uploadArchiveInput>;

export interface UploadArchiveResult {
  readonly buildId: number;
  /** What this upload produced, or will produce (§3). */
  readonly artifactType: ArtifactType;
  /**
   * `SUCCEEDED` for finished output — there was nothing to run. `PENDING` for
   * source, which `dispatchBuild` picks up.
   */
  readonly status: 'SUCCEEDED' | 'PENDING';
  /** §16's join, echoed so a caller can correlate without re-reading the row. */
  readonly bundleDigest: string;
}

export const uploadArchive: Command<
  UploadArchiveInput,
  UploadArchiveResult
> = async (input, context) => {
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

  // With the boundary, because half of what names a Target lives there.
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target with id ${input.targetId}`);
  }

  const source: ArchiveSource = {
    kind: 'archive',
    digest: input.bundleDigest,
    location: input.location,
    contents: input.contents,
    subpath: input.subpath,
  };

  const supplied = isSuppliedArtifact(source);

  // §3: shape follows the Target, not the kind.
  const shape = supplied
    ? SUPPLIED_ARTIFACT_TYPE
    : artifactTypeFor(
        component.kind,
        placementTargetOf(target, {
          artifactTypes:
            context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
          manifest: context.manifest,
        }),
      );

  const now = context.clock.now();

  // §2 keys a Build on (component, commit, target-shape), and for an upload the
  // bundle digest *is* the commit. Re-uploading identical bytes for the same
  // shape therefore lands on the row that already describes them rather than
  // minting a second one that means the same thing.
  const [row] = await context.db
    .insert(builds)
    .values({
      componentId: component.id,
      commit: commitOf(source),
      targetShape: shape,
      artifactType: shape,
      // The digest is over the uploaded bundle on **both** arms (§16). What
      // differs is only whether it also names a finished artifact.
      artifactDigest: supplied ? input.bundleDigest : null,
      artifactRefs: supplied ? [input.location] : null,
      bundleDigest: input.bundleDigest,
      // Recorded on **both** arms, unlike `artifactRefs`. A source bundle has no
      // artifact to be addressed by, and if its location only survived on the
      // supplied arm then `dispatchBuild` would hand every source upload's
      // builder an empty location — a build that cannot fetch what it is
      // building.
      bundleLocation: input.location,
      bundleSubpath: input.subpath,
      status: supplied ? 'SUCCEEDED' : 'PENDING',
      // §4 makes the backend and its fidelity visible on the Build. A supplied
      // artifact has neither, and saying so is more useful than naming a runner
      // that never ran.
      runner: null,
      logFidelity: null,
      createdAt: now,
    })
    // Nothing is overwritten on conflict. The key is (component, commit,
    // target-shape) and the commit *is* the bundle digest, so a conflict means
    // byte-identical input for the same shape — there is nothing new to write,
    // and writing anyway is how a re-upload blanks the artifact refs of a Build
    // that had already succeeded.
    .onConflictDoNothing()
    .returning();

  // `DO NOTHING` returns no row when it did nothing, so the existing one is
  // read back: the caller asked which Build describes these bytes, and the
  // answer is the same either way.
  const build =
    row ?? (await existingBuild(context, component.id, source, shape));
  if (build === undefined) {
    return failed(
      'NOT_FOUND',
      'the Build for this bundle could not be read back after writing it',
    );
  }

  return ok({
    buildId: build.id,
    artifactType: shape,
    status: build.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PENDING',
    bundleDigest: input.bundleDigest,
  });
};

/** The Build this upload's key already names, when the insert conflicted. */
async function existingBuild(
  context: CommandContext,
  componentId: string,
  source: ArchiveSource,
  shape: ArtifactType,
) {
  const [row] = await context.db
    .select()
    .from(builds)
    .where(
      and(
        eq(builds.componentId, componentId),
        eq(builds.commit, commitOf(source)),
        eq(builds.targetShape, shape),
      ),
    );
  return row;
}
