/**
 * Where a route can publish. `buildctl` exports every reference in one
 * operation, so a registry the route cannot authorize fails the whole export.
 */
import { describe, expect, test } from 'bun:test';
import { CloudBuildRoute } from '../../src/adapters/build/cloud-build.ts';
import { GitHubActionsBuildRoute } from '../../src/adapters/build/github-actions.ts';
import { publishableRegistries } from '../../src/domain/artifact-name.ts';

const GHCR = 'ghcr.io/jonpulsifer';
const AR = 'northamerica-northeast1-docker.pkg.dev/trusted-builds/i';
const REGISTRIES = [GHCR, AR];

describe('the registries a route can publish to', () => {
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

  /** Its run logs into GHCR and federates to the artifact registry. */
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
