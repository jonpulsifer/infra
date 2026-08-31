/**
 * Reading a bundle's failure into §6's vocabulary.
 *
 * The reader itself is `@repo/archive/bundle` — a gzipped tar is the format two
 * hosts agree on rather than a Spindrift idea, and the kthx server reads one
 * with the same code. What stays here is the half that assigns blame: §6's
 * failure vocabulary is this app's, and a package that had to import
 * `DeployVerdict` to describe a torn archive would be carrying this app's
 * contract into every host that installs it.
 */
import { BundleError } from '@repo/archive/bundle';
import type { DeployRef, DeployVerdict } from '../contract.ts';

/**
 * The artifact was addressed and the bytes were not there (§6's platform
 * blame).
 *
 * A class rather than a message, because the three `files` backends all learn
 * this while fetching and all answer it in {@link bundleFailure} — and each of
 * them held its own copy of it until this one. Three private classes with the
 * same name are three `instanceof` checks that cannot see each other's
 * instances, which is a bug waiting for the day one backend's fetch helper is
 * reused by another.
 */
export class ArtifactUnavailable extends Error {
  override readonly name = 'ArtifactUnavailable';
}

/**
 * A bundle that could not be read, in §6's vocabulary.
 *
 * Three causes and three different indictments, which is the whole content of
 * this function: the bytes not being fetchable is the platform's
 * (`ARTIFACT_UNAVAILABLE`), the bytes arriving and not being a `files` artifact
 * is the build having produced something unusable and therefore the developer's
 * (`BUILD_FAILED` — the one reason §22 put in the shared vocabulary for exactly
 * this crossing), and anything else is ours.
 *
 * Shared because §6's failure vocabulary is closed: three backends mapping the
 * same torn archive to different reasons would put two meanings on one word in
 * a UI that shows the user a single timeline.
 */
export function bundleFailure(
  cause: unknown,
  ref: DeployRef,
): Extract<DeployVerdict, { phase: 'FAILED' }> {
  if (cause instanceof ArtifactUnavailable) {
    return {
      phase: 'FAILED',
      ref,
      reason: 'ARTIFACT_UNAVAILABLE',
      detail: cause.message,
    };
  }
  if (cause instanceof BundleError) {
    return {
      phase: 'FAILED',
      ref,
      reason: 'BUILD_FAILED',
      detail: cause.message,
      debug: { code: cause.code },
    };
  }
  return {
    phase: 'FAILED',
    ref,
    reason: 'INTERNAL',
    detail: cause instanceof Error ? cause.message : String(cause),
  };
}
