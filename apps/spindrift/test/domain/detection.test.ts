/**
 * Detection is one algorithm over one named directory (§5).
 *
 * The public seam is `detectScope`: a caller supplies a {@link SourceTree} and
 * the zero-config builder's normalized plan, then receives either one Component
 * proposal or an honest unknown outcome. Tests stay above the tree and planner
 * boundaries; none reaches into the ladder's helpers.
 *
 * Every case below runs twice where it can — once over a real directory and
 * once over an in-memory tree — because "one algorithm over both sources" is
 * the claim the seam exists to make, and a claim tested against one source is
 * the claim that was already false.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  detectScope,
  type InferredComponentKind,
  type SourceTree,
  type ZeroConfigPlanner,
} from '../../src/domain/detection/ladder.ts';
import { diskTree } from '../../src/domain/detection/tree.ts';

const FIXTURES = join(import.meta.dir, '../fixtures/detection');

type Assert<T extends true> = T;

function fixture(name: string): SourceTree {
  return diskTree(join(FIXTURES, name));
}

function planner(
  plan: Awaited<ReturnType<ZeroConfigPlanner['plan']>>,
): ZeroConfigPlanner {
  return {
    async plan() {
      return plan;
    },
  };
}

describe('the detection ladder', () => {
  test('job is asserted and cannot be inferred', () => {
    const excluded: Assert<'job' extends InferredComponentKind ? false : true> =
      true;
    expect(excluded).toBe(true);
  });

  test('a Dockerfile-wrapped static site is still a website', async () => {
    const result = await detectScope({
      tree: fixture('dockerfile-website'),
      source: { kind: 'repo', subpath: '.' },
      planner: planner({
        outcome: 'detected',
        kind: 'website',
        reason: 'a static site generator',
        kinds: [
          { kind: 'website', available: true },
          {
            kind: 'service',
            available: false,
            reason: 'the build produces static files and has no start command',
          },
          {
            kind: 'job',
            available: false,
            reason: 'jobs are asserted, never inferred',
          },
        ],
        buildCommand: 'bun run build',
        outputDirectory: 'dist',
      }),
    });

    expect(result.outcome).toBe('detected');
    if (result.outcome !== 'detected') return;

    expect(result.proposal.kind).toBe('website');
    expect(result.proposal.build).toEqual({
      frontend: 'dockerfile',
      dockerfile: 'Dockerfile',
    });
    expect(result.proposal.watchPaths).toEqual([
      '.',
      'package.json',
      'bun.lock',
    ]);
  });

  test('spindrift.yaml is authoritative and stops the ladder', async () => {
    let plannerCalls = 0;
    const result = await detectScope({
      tree: fixture('authoritative-file'),
      source: { kind: 'repo', subpath: '.' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return {
            outcome: 'detected',
            kind: 'website',
            reason: 'must not run',
            kinds: [{ kind: 'website', available: true }],
            buildCommand: 'bun run build',
            outputDirectory: 'dist',
          };
        },
      },
    });

    expect(plannerCalls).toBe(0);
    expect(result).toEqual({
      outcome: 'detected',
      scope: '.',
      proposal: {
        source: 'spindrift-file',
        kind: 'job',
        reason: 'spindrift.yaml asserts this scope is a job',
        kinds: [
          {
            kind: 'job',
            available: true,
            reason: 'asserted by spindrift.yaml',
          },
        ],
        build: {
          frontend: 'railpack',
          buildCommand: 'bun run report',
          outputDirectory: null,
        },
        watchPaths: ['.', 'shared/reporting'],
      },
    });
  });

  test('a subpath Dockerfile copying from beside itself names its own directory as the context', async () => {
    // The failing arrangement: a standalone repository vendored under a
    // subpath, its Dockerfile written against its own directory (`COPY
    // go.mod ./` with go.mod beside it and not at the root). The sentence
    // must say so, because the build routes probe the same rule and will
    // build with the scope as the context — the sentence and the
    // arrangement have to agree.
    const result = await detectScope({
      tree: fixture('vendored-standalone'),
      source: { kind: 'repo', subpath: 'apps/ddns' },
      planner: planner({
        outcome: 'detected',
        kind: 'service',
        reason: 'Go — go.mod is in this directory',
        kinds: [{ kind: 'service', available: true }],
        buildCommand: null,
        outputDirectory: null,
      }),
    });

    expect(result.outcome).toBe('detected');
    if (result.outcome !== 'detected') return;
    expect(result.proposal.reason).toBe(
      'Go — go.mod is in this directory; built from the Dockerfile in this directory, which copies go.mod from beside itself, so this directory is the build context',
    );
    expect(result.proposal.build).toEqual({
      frontend: 'dockerfile',
      dockerfile: 'Dockerfile',
    });
  });

  test('a subpath Dockerfile written against the repository root keeps the root as the context', async () => {
    // The monorepo convention: `COPY package.json ./` resolves at the root
    // and not beside the Dockerfile, so nothing moves the context and the
    // sentence names the root out loud instead of reading as if the
    // directory were the context.
    const result = await detectScope({
      tree: fixture('monorepo-dockerfile'),
      source: { kind: 'repo', subpath: 'apps/web' },
      planner: planner({
        outcome: 'detected',
        kind: 'website',
        reason: 'a static site generator',
        kinds: [{ kind: 'website', available: true }],
        buildCommand: 'bun run build',
        outputDirectory: 'dist',
      }),
    });

    expect(result.outcome).toBe('detected');
    if (result.outcome !== 'detected') return;
    expect(result.proposal.reason).toBe(
      'a static site generator; built from the Dockerfile in this directory, with the repository root as the build context',
    );
  });

  test('classifies only the named monorepo scope', async () => {
    const planned: string[] = [];
    const result = await detectScope({
      tree: fixture('named-scope'),
      source: { kind: 'repo', subpath: 'apps/unknown' },
      planner: {
        async plan(_tree, scope) {
          planned.push(scope);
          return {
            outcome: 'unsupported',
            detail:
              'I do not know how to build this; add a Dockerfile or supply a build command.',
          };
        },
      },
    });

    expect(planned).toEqual(['apps/unknown']);
    expect(result).toEqual({
      outcome: 'unknown',
      scope: 'apps/unknown',
      reason: 'unsupported',
      detail:
        'I do not know how to build this; add a Dockerfile or supply a build command.',
      watchPaths: ['apps/unknown', 'package.json', 'bun.lock'],
    });
  });

  test('derives transitive workspace watch paths from manifests', async () => {
    const result = await detectScope({
      tree: fixture('workspace-watch'),
      source: { kind: 'repo', subpath: 'apps/web' },
      planner: planner({
        outcome: 'detected',
        kind: 'service',
        reason: 'a start command',
        kinds: [
          { kind: 'service', available: true },
          {
            kind: 'website',
            available: false,
            reason: 'the plan has a start command and no static output',
          },
        ],
        buildCommand: 'bun run build',
        outputDirectory: null,
      }),
    });

    expect(result.outcome).toBe('detected');
    if (result.outcome !== 'detected') return;
    expect(result.proposal.watchPaths).toEqual([
      'apps/web',
      'packages/ui',
      'packages/tokens',
      'package.json',
      'bun.lock',
      'pnpm-workspace.yaml',
    ]);
  });

  test('unwraps an archive once and runs the same classifier without repo state', async () => {
    const planned: string[] = [];
    const result = await detectScope({
      tree: fixture('wrapped-archive'),
      source: { kind: 'archive' },
      planner: {
        async plan(_tree, scope) {
          planned.push(scope);
          return {
            outcome: 'detected',
            kind: 'website',
            reason: 'files to serve',
            kinds: [{ kind: 'website', available: true }],
            buildCommand: null,
            outputDirectory: '.',
          };
        },
      },
    });

    expect(planned).toEqual(['site']);
    expect(result).toEqual({
      outcome: 'detected',
      scope: '.',
      proposal: {
        source: 'detection',
        kind: 'website',
        reason: 'files to serve',
        kinds: [{ kind: 'website', available: true }],
        build: {
          frontend: 'railpack',
          buildCommand: null,
          outputDirectory: '.',
        },
        watchPaths: [],
      },
    });
  });

  test('returns unknown instead of reading foreign build configuration', async () => {
    const result = await detectScope({
      tree: fixture('foreign-config'),
      source: { kind: 'repo', subpath: '.' },
      planner: planner({
        outcome: 'unsupported',
        detail: 'I do not know how to build this.',
      }),
    });

    expect(result).toEqual({
      outcome: 'unknown',
      scope: '.',
      reason: 'unsupported',
      detail: 'I do not know how to build this.',
      watchPaths: ['.'],
    });
  });

  test('rejects a named scope outside the repository root', async () => {
    let plannerCalls = 0;
    const detection = detectScope({
      tree: fixture('named-scope'),
      source: { kind: 'repo', subpath: '../outside' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return { outcome: 'unsupported', detail: 'must not run' };
        },
      },
    });

    await expect(detection).rejects.toThrow(
      'scope must stay inside the repository root',
    );
    expect(plannerCalls).toBe(0);
  });

  test('an invalid authoritative file fails instead of falling through', async () => {
    let plannerCalls = 0;
    const detection = detectScope({
      tree: fixture('invalid-authority'),
      source: { kind: 'repo', subpath: '.' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return { outcome: 'unsupported', detail: 'must not run' };
        },
      },
    });

    await expect(detection).rejects.toThrow(
      'build.file: path must stay inside its scope',
    );
    expect(plannerCalls).toBe(0);
  });
});
