/**
 * Where a route can actually publish (§13, §16).
 *
 * §16 pushes every artifact to every registry, and §13 authorizes each push by
 * the route that makes it. Those two sentences only agree when the route's own
 * identity reaches every registry — and it does not. The hosted run logs into
 * GHCR and federates to the artifact registry; the cloud builder's metadata
 * token is good for one vendor and nothing else.
 *
 * The cost of getting this wrong is not a skipped destination. `buildctl`
 * exports every reference in one operation, so an unauthorized host is a `401`
 * that fails the whole export with the image already built.
 */
import { describe, expect, test } from 'bun:test';
import { CloudBuildRoute } from '../../src/adapters/build/cloud-build.ts';
import { GitHubActionsBuildRoute } from '../../src/adapters/build/github-actions.ts';
import { publishableRegistries } from '../../src/domain/artifact-name.ts';

const GHCR = 'ghcr.io/jonpulsifer';
const AR = 'northamerica-northeast1-docker.pkg.dev/trusted-builds/i';
const REGISTRIES = [GHCR, AR];

describe('the registries a route can publish to', () => {
  /** The default this whole change exists to produce. */
  test('the cloud builder publishes to the artifact registry alone', () => {
    const route = new CloudBuildRoute({
      name: 'managed',
      endpoint: 'https://builds.example.test',
      logsEndpoint: 'https://logs.example.test',
      project: 'p',
      region: 'r',
      image: 'img',
      zeroConfigFrontend: 'zc',
      signer: '',
      attestor: '',
      token: () => 't',
    });

    expect(
      publishableRegistries({
        registries: REGISTRIES,
        selfAuthorized: route.selfAuthorizedRegistries,
      }),
    ).toEqual([AR]);
  });

  /**
   * The hosted route is unchanged by any of this, and that is the point: its
   * run holds both identities, so narrowing takes nothing away from it.
   */
  test('the hosted route publishes to both, as it always did', () => {
    const route = new GitHubActionsBuildRoute({
      name: 'hosted',
      host: {} as never,
      buildWorkflow: `o/r/.github/workflows/b.yml@${'0'.repeat(40)}`,
      zeroConfigFrontend: 'zc',
      signer: '',
      attestor: '',
    });

    expect(
      publishableRegistries({
        registries: REGISTRIES,
        selfAuthorized: route.selfAuthorizedRegistries,
      }),
    ).toEqual(REGISTRIES);
  });

  /** §16's stored exception, doing exactly what it exists for. */
  test('a stored credential widens a route back out', () => {
    expect(
      publishableRegistries({
        registries: REGISTRIES,
        selfAuthorized: ['artifactRegistry'],
        storedHosts: new Set(['ghcr.io']),
      }),
    ).toEqual(REGISTRIES);
  });

  test('a registry nothing authorizes is simply not a destination', () => {
    expect(
      publishableRegistries({
        registries: [...REGISTRIES, 'docker.io/jonpulsifer'],
        selfAuthorized: ['artifactRegistry', 'ghcr'],
      }),
    ).toEqual(REGISTRIES);
  });
});
