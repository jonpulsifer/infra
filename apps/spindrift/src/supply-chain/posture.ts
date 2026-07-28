/**
 * A derived supply-chain posture (§16).
 *
 * Posture is neither persisted nor scored. It explains the evidence behind one
 * Deploy in the two groups the product settled: enforced and not known.
 */
import type { BuildLevel } from '../adapters/build/contract.ts';
import type { DeployPhase } from '../adapters/deploy/contract.ts';

export type TargetVerification = 'enforcing' | 'audit' | 'absent';

export interface PostureInput {
  readonly phase: DeployPhase;
  readonly sourceReceiptVerified: boolean;
  readonly backend: string;
  readonly requiredLevel: BuildLevel;
  readonly achievedLevel: BuildLevel | null;
  readonly coreSignatureRecorded: boolean;
  readonly targetVerification: TargetVerification;
  readonly buildkitProvenanceRef: string | null;
  readonly sbomRef: string | null;
  readonly base: {
    readonly digest: string;
    readonly latestDigest: string | null;
  } | null;
  readonly platformVerdict: DeployPhase;
}

export interface PostureItem {
  readonly key: string;
  readonly detail: string;
}

export interface Posture {
  readonly enforced: readonly PostureItem[];
  readonly notKnown: readonly PostureItem[];
  readonly policyDrift: PolicyDrift;
}

export interface PolicyDrift {
  readonly drifted: boolean;
  readonly reason: string | null;
}

export function policyDrift(input: {
  readonly phase: DeployPhase;
  readonly achievedLevel: BuildLevel | null;
  readonly requiredLevel: BuildLevel;
}): PolicyDrift {
  if (
    input.phase !== 'LIVE' ||
    input.achievedLevel === null ||
    input.achievedLevel >= input.requiredLevel
  ) {
    return { drifted: false, reason: null };
  }
  return {
    drifted: true,
    reason: `verified Build Level ${input.achievedLevel} is below this Target’s current L${input.requiredLevel} policy`,
  };
}

export function postureFor(input: PostureInput): Posture | null {
  // Posture explains an admission that happened. Red and in-flight attempts
  // use the diagnosis surface and never get a second assessment UI.
  if (input.phase !== 'LIVE') return null;

  const enforced: PostureItem[] = [];
  const notKnown: PostureItem[] = [];

  if (input.sourceReceiptVerified) {
    enforced.push({
      key: 'source-receipt',
      detail: 'the source receipt joined this Build on its bundle digest',
    });
  } else {
    notKnown.push({
      key: 'source-receipt',
      detail: 'no verified source receipt is recorded',
    });
  }

  if (
    input.achievedLevel !== null &&
    input.achievedLevel >= input.requiredLevel
  ) {
    enforced.push({
      key: 'backend-provenance',
      detail: `${input.backend} achieved Build Level ${input.achievedLevel} against required L${input.requiredLevel}`,
    });
  } else {
    notKnown.push({
      key: 'backend-provenance',
      detail: 'no backend provenance was admitted at the current Target policy',
    });
  }

  if (input.coreSignatureRecorded && input.targetVerification === 'enforcing') {
    enforced.push({
      key: 'core-signature',
      detail:
        'core signed after provenance verification and the Target enforces that signature',
    });
  } else {
    notKnown.push({
      key: 'core-signature',
      detail: input.coreSignatureRecorded
        ? 'core recorded a signature, but the Target does not enforce it'
        : 'core recorded no artifact signature',
    });
  }

  notKnown.push({
    key: 'source-controls',
    detail: 'source controls may be observed, but continuity is unverified',
  });

  notKnown.push({
    key: 'buildkit-provenance',
    detail:
      input.buildkitProvenanceRef === null
        ? 'BuildKit materials are not available'
        : 'BuildKit materials were recorded but are unsigned',
  });

  notKnown.push({
    key: 'sbom',
    detail:
      input.sbomRef === null
        ? 'contents were not recorded'
        : 'contents were recorded as SPDX and are not assessed in v1',
  });

  if (input.base === null) {
    notKnown.push({
      key: 'base-freshness',
      detail: 'the Build did not identify a configured base',
    });
  } else if (
    input.base.latestDigest !== null &&
    input.base.latestDigest !== input.base.digest
  ) {
    notKnown.push({
      key: 'base-freshness',
      detail: `base ${input.base.digest} is stale; rebuild to use ${input.base.latestDigest}`,
    });
  } else {
    notKnown.push({
      key: 'base-freshness',
      detail:
        input.base.latestDigest === null
          ? `base ${input.base.digest} has no current configured digest to compare`
          : `base ${input.base.digest} matched the configured digest at build time; freshness remains advisory`,
    });
  }

  notKnown.push({
    key: 'platform-verdict',
    detail: `the platform reports ${input.platformVerdict}; this is an observation, not an assessment`,
  });

  return {
    enforced,
    notKnown,
    policyDrift: policyDrift(input),
  };
}
