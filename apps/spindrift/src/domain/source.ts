/**
 * Where an App's code comes from. A repo and an archive share one pipeline; an
 * archive of finished output skips the build but is digested over the same
 * uploaded bundle, so its receipt and provenance still name one digest.
 */
import type { BuildOrigin } from '../adapters/build/contract.ts';
import type { ArtifactType } from './desired-state.ts';

/**
 * `artifact` is finished output core records as is; `source` is code that goes
 * through detection. The uploader states which.
 */
export type ArchiveContents = 'artifact' | 'source';

export interface RepoSource {
  readonly kind: 'repo';
  readonly url: string;
  readonly commit: string;
  /** The named scope; it is never searched for. */
  readonly subpath: string;
  /** Where the staged bundle is fetched from; a route never pulls the repository. */
  readonly location: string;
}

export interface ArchiveSource {
  readonly kind: 'archive';
  /** Over the staged bundle. */
  readonly digest: string;
  readonly location: string;
  readonly contents: ArchiveContents;
  /** Applied after unwrapping a lone top-level directory. */
  readonly subpath: string;
}

export type Source = RepoSource | ArchiveSource;

export function isSuppliedArtifact(source: Source): boolean {
  return source.kind === 'archive' && source.contents === 'artifact';
}

/**
 * An uploaded image would need a registry push core does not do and a digest
 * core did not compute.
 */
export const SUPPLIED_ARTIFACT_TYPE: ArtifactType = 'files';

/**
 * An archive has no commit, so its bundle digest stands in: re-uploading the same
 * bytes reuses the Build.
 */
export function commitOf(source: Source): string {
  return source.kind === 'repo' ? source.commit : source.digest;
}

export function buildOriginOf(source: Source): BuildOrigin {
  return source.kind === 'repo'
    ? {
        type: 'repo',
        repository: source.url,
        commit: source.commit,
        subpath: source.subpath,
        location: source.location,
      }
    : {
        type: 'archive',
        location: source.location,
        subpath: source.subpath,
      };
}
