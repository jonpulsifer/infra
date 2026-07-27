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
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { builds, components, targets } from '../../db/schema.ts';
import { capabilitiesOfRow } from '../../domain/capabilities.ts';
import type { ArtifactType } from '../../domain/desired-state.ts';
import { artifactTypeFor } from '../../domain/placement.ts';
import {
  type ArchiveSource,
  commitOf,
  SUPPLIED_ARTIFACT_TYPE,
} from '../../domain/source.ts';
import { type Command, failed, ok } from '../types.ts';

/** A content digest over the staged bundle (§16). */
const bundleDigest = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 digest');

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

  const [target] = await context.db
    .select()
    .from(targets)
    .where(eq(targets.id, input.targetId));
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

  // §3: shape follows the Target, not the kind. A website lands as `files` on a
  // static Target and as a server image anywhere else, and the Build's key
  // carries whichever it was.
  const shape =
    input.contents === 'artifact'
      ? SUPPLIED_ARTIFACT_TYPE
      : artifactTypeFor(component.kind, {
          id: target.id,
          name: target.name,
          adapter: target.adapter,
          rank: target.rank,
          healthy: target.health === 'healthy',
          capabilities: capabilitiesOfRow(target, {
            artifactTypes:
              context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
            manifest: context.manifest,
          }),
        });

  const supplied = input.contents === 'artifact';
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
      status: supplied ? 'SUCCEEDED' : 'PENDING',
      // §4 makes the backend and its fidelity visible on the Build. A supplied
      // artifact has neither, and saying so is more useful than naming a runner
      // that never ran.
      runner: null,
      logFidelity: null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [builds.componentId, builds.commit, builds.targetShape],
      set: { artifactRefs: supplied ? [input.location] : null },
    })
    .returning();

  return ok({
    buildId: row!.id,
    artifactType: shape,
    status: supplied ? 'SUCCEEDED' : 'PENDING',
    bundleDigest: input.bundleDigest,
  });
};
