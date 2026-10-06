import { describe, expect, test } from 'bun:test';
import { policyDrift, postureFor } from '../../src/supply-chain/posture.ts';

const evidence = {
  phase: 'LIVE' as const,
  sourceReceiptVerified: true,
  backend: 'hosted',
  requiredLevel: 2 as const,
  achievedLevel: 2 as const,
  coreSignatureRecorded: true,
  targetVerification: 'enforcing' as const,
  buildkitProvenanceRef: 'registry.example.test/app@sha256:abc',
  sbomRef: 'registry.example.test/app@sha256:abc',
  base: {
    digest: 'sha256:base',
    latestDigest: 'sha256:newer',
  },
  platformVerdict: 'LIVE' as const,
};

describe('policy drift is prospective', () => {
  test('a live workload below a raised minimum drifts without becoming failed', () => {
    expect(
      policyDrift({ phase: 'LIVE', achievedLevel: 2, requiredLevel: 3 }),
    ).toEqual({
      drifted: true,
      reason: 'verified Build Level 2 is below this Target’s current L3 policy',
    });
  });

  test('a pending or failed attempt is not called policy drift', () => {
    expect(
      policyDrift({ phase: 'PENDING', achievedLevel: 2, requiredLevel: 3 }),
    ).toEqual({ drifted: false, reason: null });
    expect(
      policyDrift({ phase: 'FAILED', achievedLevel: 2, requiredLevel: 3 }),
    ).toEqual({ drifted: false, reason: null });
  });
});

describe('posture is an explanation, not a score', () => {
  test('separates enforced evidence from named unknowns', () => {
    const posture = postureFor(evidence);

    expect(posture).not.toHaveProperty('score');
    expect(posture).not.toBeNull();
    if (posture === null) return;
    expect(posture).not.toHaveProperty('level');
    expect(posture.enforced.map((item) => item.key)).toEqual([
      'source-receipt',
      'backend-provenance',
      'core-signature',
    ]);
    expect(posture.notKnown).toContainEqual({
      key: 'sbom',
      detail: 'contents were recorded as SPDX and are not assessed in v1',
    });
    expect(posture.notKnown).toContainEqual({
      key: 'base-freshness',
      detail: 'base sha256:base is stale; rebuild to use sha256:newer',
    });
    expect(posture.enforced.length + posture.notKnown.length).toBe(8);
  });

  test('an audit-only Target never reads as enforced verification', () => {
    const posture = postureFor({
      ...evidence,
      targetVerification: 'audit',
    });

    expect(posture).not.toBeNull();
    if (posture === null) return;
    expect(posture.notKnown).toContainEqual({
      key: 'core-signature',
      detail: 'core recorded a signature, but the Target does not enforce it',
    });
  });

  test('failed assessments stay on the diagnosis surface', () => {
    expect(postureFor({ ...evidence, phase: 'FAILED' })).toBeNull();
  });
});
