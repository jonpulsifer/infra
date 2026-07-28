/**
 * Detection is one algorithm over one named directory (§5).
 *
 * The public seam is `detectScope`: a caller supplies the directory and the
 * zero-config builder's normalized plan, then receives either one Component
 * proposal or an honest unknown outcome. Tests stay above the filesystem and
 * planner boundaries; none reaches into the ladder's helpers.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  detectScope,
  type InferredComponentKind,
  type ZeroConfigPlanner,
} from '../../src/domain/detection/ladder.ts';

const FIXTURES = join(import.meta.dir, '../fixtures/detection');

type Assert<T extends true> = T;

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
      repositoryRoot: join(FIXTURES, 'dockerfile-website'),
      source: { kind: 'repo', subpath: '.' },
      planner: planner({
        outcome: 'detected',
        kind: 'website',
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
      repositoryRoot: join(FIXTURES, 'authoritative-file'),
      source: { kind: 'repo', subpath: '.' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return {
            outcome: 'detected',
            kind: 'website',
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

  test('classifies only the named monorepo scope', async () => {
    const plannedDirectories: string[] = [];
    const result = await detectScope({
      repositoryRoot: join(FIXTURES, 'named-scope'),
      source: { kind: 'repo', subpath: 'apps/unknown' },
      planner: {
        async plan(directory) {
          plannedDirectories.push(directory);
          return {
            outcome: 'unsupported',
            detail:
              'I do not know how to build this; add a Dockerfile or supply a build command.',
          };
        },
      },
    });

    expect(plannedDirectories).toEqual([
      join(FIXTURES, 'named-scope/apps/unknown'),
    ]);
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
      repositoryRoot: join(FIXTURES, 'workspace-watch'),
      source: { kind: 'repo', subpath: 'apps/web' },
      planner: planner({
        outcome: 'detected',
        kind: 'service',
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
    const plannedDirectories: string[] = [];
    const result = await detectScope({
      repositoryRoot: join(FIXTURES, 'wrapped-archive'),
      source: { kind: 'archive' },
      planner: {
        async plan(directory) {
          plannedDirectories.push(directory);
          return {
            outcome: 'detected',
            kind: 'website',
            kinds: [{ kind: 'website', available: true }],
            buildCommand: null,
            outputDirectory: '.',
          };
        },
      },
    });

    expect(plannedDirectories).toEqual([
      join(FIXTURES, 'wrapped-archive/site'),
    ]);
    expect(result).toEqual({
      outcome: 'detected',
      scope: '.',
      proposal: {
        source: 'railpack',
        kind: 'website',
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
      repositoryRoot: join(FIXTURES, 'foreign-config'),
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
      repositoryRoot: join(FIXTURES, 'named-scope'),
      source: { kind: 'repo', subpath: '../outside' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return {
            outcome: 'unsupported',
            detail: 'must not run',
          };
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
      repositoryRoot: join(FIXTURES, 'invalid-authority'),
      source: { kind: 'repo', subpath: '.' },
      planner: {
        async plan() {
          plannerCalls += 1;
          return {
            outcome: 'unsupported',
            detail: 'must not run',
          };
        },
      },
    });

    await expect(detection).rejects.toThrow(
      'build.file: path must stay inside its scope',
    );
    expect(plannerCalls).toBe(0);
  });
});
