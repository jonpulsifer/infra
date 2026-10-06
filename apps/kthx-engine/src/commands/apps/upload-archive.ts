/**
 * `uploadArchive`: records a Build for an uploaded bundle, whose digest the
 * caller supplies. Finished output is born `SUCCEEDED` with that digest as its
 * artifact; source stays `PENDING` for `dispatchBuild`.
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

const bundleDigest = digestSchema;

export const uploadArchiveInput = z
  .object({
    componentId: z.uuid(),
    /** Required: a Build's key includes the artifact shape the Target decides. */
    targetId: z.uuid(),
    bundleDigest,
    /** Where the staged bundle is fetched from. */
    location: z.string().trim().min(1),
    /** `artifact` is finished output; `source` is built. */
    contents: z.enum(['artifact', 'source']),
    /** The scope, after a lone top-level directory has been unwrapped. */
    subpath: z.string().trim().min(1).default('.'),
  })
  .strict();

export type UploadArchiveInput = z.infer<typeof uploadArchiveInput>;

export interface UploadArchiveResult {
  readonly buildId: number;
  readonly artifactType: ArtifactType;
  /** The Build's status, reported as `PENDING` until it succeeds. */
  readonly status: 'SUCCEEDED' | 'PENDING';
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

  // The Build key is (component, commit, shape), and an upload's commit is its
  // bundle digest, so identical bytes for the same shape reuse the row.
  const [row] = await context.db
    .insert(builds)
    .values({
      componentId: component.id,
      commit: commitOf(source),
      targetShape: shape,
      artifactType: shape,
      artifactDigest: supplied ? input.bundleDigest : null,
      artifactRefs: supplied ? [input.location] : null,
      bundleDigest: input.bundleDigest,
      // Both arms: `dispatchBuild` fetches a source upload from here.
      bundleLocation: input.location,
      bundleSubpath: input.subpath,
      status: supplied ? 'SUCCEEDED' : 'PENDING',
      runner: null,
      logFidelity: null,
      createdAt: now,
    })
    // Never overwrite: a conflict is identical input, and an update would blank
    // the artifact refs of a Build that already succeeded.
    .onConflictDoNothing()
    .returning();

  // `DO NOTHING` returns no row on conflict, so read the existing one back.
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
