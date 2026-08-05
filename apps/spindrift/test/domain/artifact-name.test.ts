/**
 * What a Component's artifact is called at the registry.
 *
 * The rule these cover is the one a registry enforces and nothing in this
 * codebase did: a repository is a *path*, and the installation's registry (§16)
 * is only its prefix. Every fixture in the adapter tests already supplied a
 * repository-shaped value, so the adapters were tested against the shape they
 * expect while the one place that produced the wrong shape had no test at all.
 */
import { describe, expect, test } from 'bun:test';
import {
  artifactTags,
  bundleTag,
  componentRepositories,
  isPathComponent,
  MOVING_TAG,
} from '../../src/domain/artifact-name.ts';

const REGISTRY = 'ghcr.io/jonpulsifer';
const DIGEST =
  'sha256:3f5cbbc2a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c';

describe('a Component’s repository', () => {
  test('nests the App and the Component under the registry', () => {
    expect(
      componentRepositories({
        registries: [REGISTRY],
        app: 'infra',
        component: 'spindrift-demo',
      }),
    ).toEqual(['ghcr.io/jonpulsifer/infra/spindrift-demo']);
  });

  test('is a repository and never the bare namespace', () => {
    const repository = componentRepositories({
      registries: [REGISTRY],
      app: 'infra',
      component: 'web',
    });
    // The defect verbatim: GHCR answers `NAME_INVALID` to a single-segment
    // path, which is what the registry alone is.
    expect(repository).not.toContain(REGISTRY);
    expect(repository?.[0]?.slice(REGISTRY.length)).toBe('/infra/web');
  });

  test('is stable — the same Component composes the same name twice', () => {
    const parts = { registries: [REGISTRY], app: 'infra', component: 'web' };
    expect(componentRepositories(parts)).toEqual(componentRepositories(parts));
  });

  test('nests rather than joining, so a hyphen in either half is unambiguous', () => {
    // `naming.ts` states the reason for canonical names and it holds here:
    // flattened, these two would both be `my-app-web-api`.
    const first = componentRepositories({
      registries: [REGISTRY],
      app: 'my-app',
      component: 'web-api',
    });
    const second = componentRepositories({
      registries: [REGISTRY],
      app: 'my-app-web',
      component: 'api',
    });
    expect(first).not.toEqual(second);
  });

  test('folds to two levels on Docker Hub, which holds no nested namespaces', () => {
    // Docker Hub is namespace/repository and nothing deeper — the nested form
    // is "push access denied, repository does not exist" after the whole
    // build. The fold gives up the unambiguity above on that one registry;
    // every other registry keeps the canonical nested name, and those are the
    // refs Deploys pin.
    expect(
      componentRepositories({
        registries: ['docker.io/jonpulsifer', REGISTRY],
        app: 'statty',
        component: 'nightly',
      }),
    ).toEqual([
      'docker.io/jonpulsifer/statty-nightly',
      'ghcr.io/jonpulsifer/statty/nightly',
    ]);
  });

  test('refuses a name no registry would accept rather than projecting it', () => {
    // Projecting would push two Components to one repository, which is the
    // quiet failure: the second build overwrites the first's tag.
    expect(
      componentRepositories({
        registries: [REGISTRY],
        app: 'My App',
        component: 'web',
      }),
    ).toBeNull();
    expect(
      componentRepositories({
        registries: [REGISTRY],
        app: 'infra',
        component: 'Web',
      }),
    ).toBeNull();
    expect(
      componentRepositories({
        registries: [REGISTRY],
        app: '',
        component: 'web',
      }),
    ).toBeNull();
  });

  test('composes one repository per registry, in the manifest’s order', () => {
    // Ticket 39: two Targets on one installation cannot always share a
    // registry, so the same digest is pushed to each. `refs[0]` stays the
    // first, which is what a Target declaring no reachability gets.
    expect(
      componentRepositories({
        registries: [
          REGISTRY,
          'northamerica-northeast1-docker.pkg.dev/trusted-builds/i',
        ],
        app: 'infra',
        component: 'web',
      }),
    ).toEqual([
      'ghcr.io/jonpulsifer/infra/web',
      'northamerica-northeast1-docker.pkg.dev/trusted-builds/i/infra/web',
    ]);
  });

  test('refuses every registry or none — never a partial push', () => {
    // A partial answer would push to one destination and silently not to the
    // other, which reads as "Cloud Run cannot pull what the cluster is running".
    expect(
      componentRepositories({
        registries: [REGISTRY, 'other.example.test/ns'],
        app: 'My App',
        component: 'web',
      }),
    ).toBeNull();
  });
});

describe('what a path segment may be', () => {
  test('accepts the separators the distribution spec allows', () => {
    expect(isPathComponent('web')).toBe(true);
    expect(isPathComponent('spindrift-demo')).toBe(true);
    expect(isPathComponent('web.api')).toBe(true);
    expect(isPathComponent('web_api')).toBe(true);
    expect(isPathComponent('web__api')).toBe(true);
    expect(isPathComponent('app2')).toBe(true);
  });

  test('rejects what a registry rejects', () => {
    expect(isPathComponent('Web')).toBe(false);
    expect(isPathComponent('my app')).toBe(false);
    expect(isPathComponent('-web')).toBe(false);
    expect(isPathComponent('web-')).toBe(false);
    expect(isPathComponent('web/api')).toBe(false);
    expect(isPathComponent('')).toBe(false);
    expect(isPathComponent('a'.repeat(64))).toBe(false);
  });
});

describe('the tags one build pushes', () => {
  test('names what was built, from the digest both routes carry', () => {
    // A colon is not legal in a tag, and an upload has no commit to use
    // instead — which is why §16 makes the bundle digest the parameter every
    // route gets.
    expect(bundleTag(DIGEST)).toBe(`sha256-${DIGEST.slice('sha256:'.length)}`);
    expect(bundleTag(DIGEST)).not.toContain(':');
  });

  test('carries an immutable tag as well as the moving one', () => {
    const tags = artifactTags(DIGEST);
    expect(tags).toEqual([bundleTag(DIGEST), MOVING_TAG]);
    // §12 retains "by tagging" with N = 10 doubling as rollback depth. Only
    // `latest` and there is nothing to count and nothing to roll back to.
    expect(tags.filter((tag) => tag !== MOVING_TAG)).toHaveLength(1);
  });

  test('is content-addressed, so an identical rebuild reuses its tag', () => {
    expect(artifactTags(DIGEST)).toEqual(artifactTags(DIGEST));
  });

  test('every tag is legal', () => {
    for (const tag of artifactTags(DIGEST)) {
      expect(tag).toMatch(/^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/);
    }
  });
});
