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
    // GHCR answers NAME_INVALID to a single-segment path such as the namespace.
    expect(repository).not.toContain(REGISTRY);
    expect(repository?.[0]?.slice(REGISTRY.length)).toBe('/infra/web');
  });

  test('is stable — the same Component composes the same name twice', () => {
    const parts = { registries: [REGISTRY], app: 'infra', component: 'web' };
    expect(componentRepositories(parts)).toEqual(componentRepositories(parts));
  });

  test('nests rather than joining, so a hyphen in either half is unambiguous', () => {
    // Flattened, both would be my-app-web-api.
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
    // Docker Hub refuses a nested path with "push access denied, repository
    // does not exist", after the build has run.
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
    // Projecting could push two Components to one repository, where the second
    // build overwrites the first's tag.
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
    // The first is what a Target that declares no reachable registry pulls.
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
    // A tag may not contain a colon, and an upload has no commit to tag by.
    expect(bundleTag(DIGEST)).toBe(`sha256-${DIGEST.slice('sha256:'.length)}`);
    expect(bundleTag(DIGEST)).not.toContain(':');
  });

  test('carries an immutable tag as well as the moving one', () => {
    const tags = artifactTags(DIGEST);
    expect(tags).toEqual([bundleTag(DIGEST), MOVING_TAG]);
    // Retention counts the immutable tags, and a rollback names one.
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
