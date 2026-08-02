/**
 * What a repository turns out to be, read without checking it out (§5).
 *
 * Two claims are under test and they are different claims:
 *
 * 1. **The planner answers from what a project declares.** A `package.json`
 *    with `next` in it is a website; a `go.mod` is a service; a library that
 *    declares neither a framework nor a start script is the honest unknown §5
 *    insists on, never a silent fallback to `service`.
 * 2. **The ladder does not care where the bytes came from.** Every case here
 *    runs over an in-memory tree — no disk, no clone — and `detection.test.ts`
 *    runs the same ladder over real directories. One algorithm, two sources,
 *    which is the whole reason `SourceTree` exists.
 */
import { describe, expect, test } from 'bun:test';
import { declaredPlanner } from '../../src/domain/detection/declared.ts';
import {
  discoverScopes,
  scanRepository,
} from '../../src/domain/detection/discover.ts';
import type { SourceTree } from '../../src/domain/detection/tree.ts';

/** A tree that is a literal, so a test states the repository it means. */
function memoryTree(files: Record<string, string>): SourceTree {
  const paths = Object.keys(files).sort();
  return {
    paths: async () => paths,
    readText: async (path) => files[path] ?? null,
  };
}

const PACKAGE = (extra: Record<string, unknown>) =>
  JSON.stringify({ name: 'thing', ...extra });

describe('planning from what a project declares', () => {
  const plan = (files: Record<string, string>, scope = '.') =>
    declaredPlanner().plan(memoryTree(files), scope);

  test('a framework dependency names the kind and where its files land', async () => {
    const result = await plan({
      'package.json': PACKAGE({ dependencies: { astro: '^5.0.0' } }),
    });

    expect(result).toEqual({
      outcome: 'detected',
      kind: 'website',
      reason: 'Astro — `astro` is a dependency in package.json',
      kinds: [
        {
          kind: 'service',
          available: false,
          reason: 'Astro builds files into dist',
        },
        { kind: 'website', available: true },
        {
          kind: 'job',
          available: false,
          reason: 'jobs are asserted, never inferred',
        },
      ],
      buildCommand: null,
      outputDirectory: 'dist',
    });
  });

  test('a server-rendering framework has no static output directory', async () => {
    const result = await plan({
      'package.json': PACKAGE({ dependencies: { next: '15.0.0' } }),
    });

    expect(result).toMatchObject({
      outcome: 'detected',
      kind: 'website',
      outputDirectory: null,
    });
  });

  test('the more specific framework wins over the bundler it is built on', async () => {
    const result = await plan({
      'package.json': PACKAGE({
        dependencies: { '@sveltejs/kit': '^2.0.0' },
        devDependencies: { vite: '^6.0.0' },
      }),
    });

    expect(result).toMatchObject({
      reason: expect.stringContaining('SvelteKit'),
    });
  });

  test('a language manifest with no package.json is a service', async () => {
    expect(
      await plan({ 'go.mod': 'module example.com/thing\n' }),
    ).toMatchObject({
      outcome: 'detected',
      kind: 'service',
      reason: 'Go — go.mod is in this directory',
    });
  });

  test('the build command is left to the builder that owns it', async () => {
    const result = await plan({
      'package.json': PACKAGE({
        dependencies: { vite: '^6.0.0' },
        scripts: { build: 'vite build --mode production' },
      }),
    });

    // Railpack reads the same package.json at build time and is better at this
    // than a table here would be. Proposing a command would be proposing the
    // answer that then wins over the builder's.
    expect(result).toMatchObject({ buildCommand: null });
  });

  test('a library is unsupported rather than quietly a service', async () => {
    const result = await plan({
      'package.json': PACKAGE({ dependencies: { zod: '^4.0.0' } }),
    });

    expect(result.outcome).toBe('unsupported');
  });

  test('a start script with no framework is a service', async () => {
    expect(
      await plan({
        'package.json': PACKAGE({ scripts: { start: 'node server.js' } }),
      }),
    ).toMatchObject({ outcome: 'detected', kind: 'service' });
  });

  test('an unparseable package.json does not throw', async () => {
    expect(await plan({ 'package.json': '{ not json' })).toMatchObject({
      outcome: 'unsupported',
    });
  });

  test('it plans the named scope, not the root', async () => {
    const result = await plan(
      {
        'package.json': PACKAGE({ workspaces: ['apps/*'] }),
        'apps/site/package.json': PACKAGE({ dependencies: { gatsby: '^5' } }),
      },
      'apps/site',
    );

    expect(result).toMatchObject({
      kind: 'website',
      outputDirectory: 'public',
    });
  });
});

describe('discovering what is in a repository', () => {
  test('a repository whose root is an App is not walked any further', async () => {
    const found = await scanRepository(
      memoryTree({
        'package.json': PACKAGE({ dependencies: { next: '15.0.0' } }),
        'apps/ignored/package.json': PACKAGE({ dependencies: { vite: '^6' } }),
      }),
      declaredPlanner(),
    );

    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ outcome: 'detected', scope: '.' });
  });

  test('a workspace root offers its declared packages', async () => {
    const found = await scanRepository(
      memoryTree({
        'package.json': PACKAGE({ workspaces: ['apps/*', 'packages/*'] }),
        'apps/web/package.json': PACKAGE({
          name: 'web',
          dependencies: { next: '15.0.0' },
        }),
        'apps/api/package.json': PACKAGE({
          name: 'api',
          scripts: { start: 'bun run index.ts' },
        }),
        'packages/ui/package.json': PACKAGE({ name: 'ui' }),
      }),
      declaredPlanner(),
    );

    // The root stays on the list wearing its reason (§3): "why not here" is as
    // much an answer as "here", and a screen that dropped it would be a screen
    // that silently decided.
    expect(
      found.map((result) => [
        result.scope,
        result.outcome,
        result.outcome === 'detected' ? result.proposal.kind : null,
      ]),
    ).toEqual([
      ['.', 'unknown', null],
      ['apps/api', 'detected', 'service'],
      ['apps/web', 'detected', 'website'],
      ['packages/ui', 'unknown', null],
    ]);
  });

  test('a repository with no workspace declaration is walked, but not deeply', async () => {
    const found = await discoverScopes(
      memoryTree({
        'README.md': '',
        'services/api/go.mod': 'module api\n',
        'services/api/vendor/dep/go.mod': 'module dep\n',
        'deep/one/two/three/package.json': PACKAGE({}),
        'node_modules/left-pad/package.json': PACKAGE({}),
      }),
    );

    // `services/api` is two deep and kept. The vendored module and the
    // `node_modules` entry are somebody else's code; `deep/one/two/three` is
    // past the depth ceiling and is reachable by naming it.
    expect(found).toEqual(['services/api']);
  });

  test('a named scope is honoured exactly, with no discovery at all', async () => {
    const found = await scanRepository(
      memoryTree({
        'package.json': PACKAGE({ dependencies: { next: '15.0.0' } }),
        'apps/api/go.mod': 'module api\n',
      }),
      declaredPlanner(),
      ['apps/api'],
    );

    expect(found.map((result) => result.scope)).toEqual(['apps/api']);
  });

  test('an in-repo spindrift.yaml wins over anything detection would say', async () => {
    const found = await scanRepository(
      memoryTree({
        'package.json': PACKAGE({ dependencies: { next: '15.0.0' } }),
        'spindrift.yaml': [
          'version: 1',
          'component:',
          '  kind: job',
          'build:',
          '  frontend: railpack',
          '  command: bun run nightly',
          '  outputDirectory: null',
          'watchPaths:',
          '  - .',
        ].join('\n'),
      }),
      declaredPlanner(),
    );

    expect(found[0]).toMatchObject({
      outcome: 'detected',
      proposal: { source: 'spindrift-file', kind: 'job' },
    });
  });
});
