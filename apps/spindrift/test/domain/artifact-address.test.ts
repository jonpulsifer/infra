/**
 * Which reference a Target pulls the artifact by (ticket 39).
 *
 * §16 named one registry per installation, and `artifactAddress` took `refs[0]`
 * because "preference would need a cost model, and §3 declines to have one".
 * Which registry a Target can reach is not a preference and needs no cost
 * model — §3 already models it as `reachableRegistries` — and taking the first
 * instead is what put a `ghcr.io` reference on a Cloud Run revision that failed
 * at the *pull*, several layers past IAM and Binary Authorization, on an
 * artifact that was signed, attested and admitted:
 *
 * ```text
 * Revision 'plainboi-web-00001-vcw' is not ready and cannot serve traffic.
 * Image 'cache.us-docker.pkg.dev/ghcr.io/jonpulsifer/plainboi/web@sha256:e6bbf889…'
 * parsing failed.
 * ```
 */
import { describe, expect, test } from 'bun:test';
import {
  type Artifact,
  artifactAddress,
} from '../../src/domain/desired-state.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const GHCR = 'ghcr.io/jonpulsifer/plainboi/web';
const AR =
  'northamerica-northeast1-docker.pkg.dev/trusted-builds/i/plainboi/web';

const PUSHED: Artifact = {
  type: 'image',
  digest: DIGEST,
  refs: [`${GHCR}@${DIGEST}`, `${AR}@${DIGEST}`],
};

describe('the address a Target pulls an artifact by', () => {
  test('is the one its registry reachability names, not the first', () => {
    // The whole ticket in one assertion: same artifact, same digest, two
    // Targets, two addresses.
    expect(
      artifactAddress(PUSHED, ['northamerica-northeast1-docker.pkg.dev']),
    ).toBe(`${AR}@${DIGEST}`);
    expect(artifactAddress(PUSHED, ['ghcr.io'])).toBe(`${GHCR}@${DIGEST}`);
  });

  /**
   * The spelling every real value uses, and the one this file did not have.
   *
   * Every case above passes a bare host, so the comparison could be
   * `reachable.includes(registryHostOf(ref))` and still come up green — while a
   * live Target, whose `reachableRegistries` is copied from
   * `supplyChain.registry` and reported back by discovery, holds
   * `ghcr.io/jonpulsifer`. That never equals `ghcr.io`, so the artifact was
   * refused with "carries no address this Target can pull it by" while sitting
   * in the exact registry the Target had named.
   */
  test('matches the namespace spelling an operator actually writes', () => {
    expect(
      artifactAddress(PUSHED, [
        'northamerica-northeast1-docker.pkg.dev/trusted-builds/i',
      ]),
    ).toBe(`${AR}@${DIGEST}`);
    expect(artifactAddress(PUSHED, ['ghcr.io/jonpulsifer'])).toBe(
      `${GHCR}@${DIGEST}`,
    );
  });

  /** The trailing slash, which is the whole of why this is a prefix and not one. */
  test('does not let one namespace claim a longer one beside it', () => {
    expect(
      artifactAddress(PUSHED, [
        'northamerica-northeast1-docker.pkg.dev/trusted-builds/im',
      ]),
    ).toBeNull();
    expect(artifactAddress(PUSHED, ['ghcr.io/jonpulsifer-two'])).toBeNull();
  });

  test('falls back to the first where a Target declares no restriction', () => {
    // Empty is "nothing was said", not "reaches nothing" — which is every
    // Target on this installation until an operator says otherwise, and is why
    // this cannot be `null`.
    expect(artifactAddress(PUSHED)).toBe(`${GHCR}@${DIGEST}`);
    expect(artifactAddress(PUSHED, [])).toBe(`${GHCR}@${DIGEST}`);
  });

  test('is null where a Target reaches none of the registries pushed to', () => {
    // The backstop. Placement makes this Target a non-candidate before a Build
    // is dispatched; an adapter reaching here anyway renders no workload rather
    // than one that cannot pull.
    expect(artifactAddress(PUSHED, ['registry.internal.example'])).toBeNull();
  });

  test('is null for an artifact with no address at all', () => {
    expect(
      artifactAddress({ type: 'image', digest: DIGEST, refs: [] }),
    ).toBeNull();
  });
});
