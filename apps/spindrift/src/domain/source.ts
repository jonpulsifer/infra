/**
 * Where an App's code comes from, and what staging it means (§4, §5, §15).
 *
 * §4 settles the shape this file exists to keep honest: **repo and archive share
 * one pipeline** — unpack, detect, build — so a source is an *origin*, not a
 * second contract. The one place the two genuinely diverge is retention (§15:
 * "repo bundles are ephemeral, archives durable"), and that divergence is a
 * property of where the bytes came from rather than a branch anything downstream
 * takes.
 *
 * The other distinction §4 draws is inside the archive, not between the two:
 *
 * > An archive of *finished output* is a supplied artifact, digested over the
 * > uploaded bundle; an archive of *source* builds normally.
 *
 * That is {@link ArchiveContents}, and it is the whole reason a `files` artifact
 * can exist with no builder ever having run. **Both arms are still digested over
 * the same uploaded bundle**, which is what keeps §16's join intact: the source
 * receipt and the provenance document name one digest whether or not a build
 * happened between them.
 *
 * Nothing here writes. The commands own the rows; this owns the three questions
 * they both have to answer the same way.
 */
import type { BuildOrigin } from '../adapters/build/contract.ts';
import type { ArtifactType } from './desired-state.ts';

/**
 * What is inside an uploaded archive (§4).
 *
 * `artifact` is finished output — a built site, a compiled bundle — which core
 * records as-is. `source` is code, which goes through §5's identical ladder.
 *
 * **This is stated by the uploader today and detected tomorrow.** §5's ladder
 * ("archives use the identical ladder after unwrapping a lone top-level
 * directory") is what will fill it in, and that ladder arrives with detection.
 * Until then the caller says which it uploaded, because the alternative — core
 * guessing from a file listing — is the unbounded surface §5 declines to read.
 */
export type ArchiveContents = 'artifact' | 'source';

/** An App sourced from a repository at one named scope (§5). */
export interface RepoSource {
  readonly kind: 'repo';
  readonly url: string;
  /** The exact commit fetched. Triggers fire on default-branch HEAD (§5, §15). */
  readonly commit: string;
  /** §5: "the scope is named, never searched." */
  readonly subpath: string;
}

/** An App sourced from an upload (§4). */
export interface ArchiveSource {
  readonly kind: 'archive';
  /** Digest over the staged bundle — §16's join, on both arms. */
  readonly digest: string;
  /** Where the staged bundle is fetched from. */
  readonly location: string;
  readonly contents: ArchiveContents;
  /** Applied after unwrapping a lone top-level directory (§5). */
  readonly subpath: string;
}

export type Source = RepoSource | ArchiveSource;

/**
 * How long a staged bundle is kept (§15).
 *
 * "Repo bundles are ephemeral, archives durable." The asymmetry is not a policy
 * choice — a repo bundle can be fetched again from the commit that produced it,
 * and an upload cannot be fetched again from anywhere. Losing the second one
 * loses the only copy.
 */
export type Retention = 'durable' | 'ephemeral';

export function retentionOf(source: Source): Retention {
  return source.kind === 'archive' ? 'durable' : 'ephemeral';
}

/**
 * Whether this source is finished output core records rather than builds (§4).
 *
 * A repo is never one: §4's supplied-artifact arm is about an *uploaded* bundle,
 * and a repository is code by construction.
 */
export function isSuppliedArtifact(source: Source): boolean {
  return source.kind === 'archive' && source.contents === 'artifact';
}

/**
 * What a supplied artifact is, as an artifact type (§6's table).
 *
 * `files`, always. §6 gives exactly one backend that accepts `files` — `static`
 * — and finished output uploaded as a bundle is what that backend serves. An
 * uploaded *image* is not a shape v1 has: it would need a registry push core
 * does not do and a digest core did not compute, which is the custody gap §16
 * closes by digesting what was actually staged.
 */
export const SUPPLIED_ARTIFACT_TYPE: ArtifactType = 'files';

/**
 * The commit a Build row records for one source.
 *
 * A Build is keyed on `(component, commit, target-shape)` (§2), and an archive
 * has no commit — so the bundle digest stands in for one. That is not a
 * workaround: the key exists to make "this exact input, this exact shape" one
 * row, and for an upload the bundle digest *is* the exact input. Using it here
 * is what makes re-uploading identical bytes reuse the Build rather than mint a
 * second one that means the same thing.
 */
export function commitOf(source: Source): string {
  return source.kind === 'repo' ? source.commit : source.digest;
}

/** The build contract's view of one source (§4). */
export function buildOriginOf(source: Source): BuildOrigin {
  return source.kind === 'repo'
    ? {
        type: 'repo',
        repository: source.url,
        commit: source.commit,
        subpath: source.subpath,
      }
    : {
        type: 'archive',
        location: source.location,
        subpath: source.subpath,
      };
}

/**
 * §5's unwrap: "archives use the identical ladder **after unwrapping a lone
 * top-level directory**."
 *
 * A ZIP made by right-clicking a folder contains that folder; one made by
 * selecting its contents does not. Both are the same upload as far as the person
 * doing it is concerned, so the ladder must see the same tree either way.
 *
 * **A lone top-level directory, and nothing else.** Two directories are a
 * monorepo whose scope is named rather than searched (§5), and one directory
 * beside a stray `README.md` is a project that happens to have a directory in
 * it. Unwrapping either would be the search §5 refuses to do.
 */
export function unwrapSubpath(topLevelEntries: readonly string[]): string {
  const entries = topLevelEntries.filter((entry) => entry.length > 0);
  const [only] = entries;
  if (entries.length !== 1 || only === undefined) return '.';
  // Directory entries carry the trailing slash the archive format wrote; a lone
  // top-level *file* is a one-file upload, not a wrapper to unwrap.
  if (!only.endsWith('/')) return '.';
  return only.slice(0, -1);
}
