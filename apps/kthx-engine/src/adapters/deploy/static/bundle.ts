/**
 * Maps a bundle read failure to a deploy verdict. The reader is
 * `@repo/archive/bundle`, which stays free of this app's failure vocabulary.
 */
import { BundleError } from '@repo/archive/bundle';
import type { DeployRef, DeployVerdict } from '../contract.ts';

/** The artifact was addressed and its bytes were not there: the platform's fault. */
export class ArtifactUnavailable extends Error {
  override readonly name = 'ArtifactUnavailable';
}

/**
 * Bytes that arrive but are not a `files` artifact are the build's fault
 * (`BUILD_FAILED`); bytes that never arrive are the platform's.
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
