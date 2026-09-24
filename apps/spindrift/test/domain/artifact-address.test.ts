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
    expect(
      artifactAddress(PUSHED, ['northamerica-northeast1-docker.pkg.dev']),
    ).toBe(`${AR}@${DIGEST}`);
    expect(artifactAddress(PUSHED, ['ghcr.io'])).toBe(`${GHCR}@${DIGEST}`);
  });

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

  test('does not let one namespace claim a longer one beside it', () => {
    expect(
      artifactAddress(PUSHED, [
        'northamerica-northeast1-docker.pkg.dev/trusted-builds/im',
      ]),
    ).toBeNull();
    expect(artifactAddress(PUSHED, ['ghcr.io/jonpulsifer-two'])).toBeNull();
  });

  test('falls back to the first where a Target declares no restriction', () => {
    expect(artifactAddress(PUSHED)).toBe(`${GHCR}@${DIGEST}`);
    expect(artifactAddress(PUSHED, [])).toBe(`${GHCR}@${DIGEST}`);
  });

  test('is null where a Target reaches none of the registries pushed to', () => {
    // Placement already excludes this Target; null is the adapter's backstop.
    expect(artifactAddress(PUSHED, ['registry.internal.example'])).toBeNull();
  });

  test('is null for an artifact with no address at all', () => {
    expect(
      artifactAddress({ type: 'image', digest: DIGEST, refs: [] }),
    ).toBeNull();
  });
});
