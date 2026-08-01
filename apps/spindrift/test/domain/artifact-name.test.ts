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
  componentRepository,
  isPathComponent,
  MOVING_TAG,
} from '../../src/domain/artifact-name.ts';

const REGISTRY = 'ghcr.io/jonpulsifer';
const DIGEST =
  'sha256:3f5cbbc2a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c';

describe('a Component’s repository', () => {
  test('nests the App and the Component under the registry', () => {
    expect(
      componentRepository({
        registry: REGISTRY,
        app: 'infra',
        component: 'spindrift-demo',
      }),
    ).toBe('ghcr.io/jonpulsifer/infra/spindrift-demo');
  });

  test('is a repository and never the bare namespace', () => {
    const repository = componentRepository({
      registry: REGISTRY,
      app: 'infra',
      component: 'web',
    });
    // The defect verbatim: GHCR answers `NAME_INVALID` to a single-segment
    // path, which is what the registry alone is.
    expect(repository).not.toBe(REGISTRY);
    expect(repository?.slice(REGISTRY.length)).toBe('/infra/web');
  });

  test('is stable — the same Component composes the same name twice', () => {
    const parts = { registry: REGISTRY, app: 'infra', component: 'web' };
    expect(componentRepository(parts)).toBe(componentRepository(parts));
  });

  test('nests rather than joining, so a hyphen in either half is unambiguous', () => {
    // `naming.ts` states the reason for canonical names and it holds here:
    // flattened, these two would both be `my-app-web-api`.
    const first = componentRepository({
      registry: REGISTRY,
      app: 'my-app',
      component: 'web-api',
    });
    const second = componentRepository({
      registry: REGISTRY,
      app: 'my-app-web',
      component: 'api',
    });
    expect(first).not.toBe(second);
  });

  test('refuses a name no registry would accept rather than projecting it', () => {
    // Projecting would push two Components to one repository, which is the
    // quiet failure: the second build overwrites the first's tag.
    expect(
      componentRepository({
        registry: REGISTRY,
        app: 'My App',
        component: 'web',
      }),
    ).toBeNull();
    expect(
      componentRepository({
        registry: REGISTRY,
        app: 'infra',
        component: 'Web',
      }),
    ).toBeNull();
    expect(
      componentRepository({ registry: REGISTRY, app: '', component: 'web' }),
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
