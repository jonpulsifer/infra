/**
 * One Component proposal from one explicitly named directory (§5).
 *
 * The zero-config builder owns language/framework detection. Core consumes a
 * normalized plan instead of duplicating those heuristics, then selects the
 * build frontend independently: a Dockerfile changes how code is built, never
 * what kind of Component it is.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { ComponentKind } from '../desired-state.ts';
import type { DetectionSource } from './scope.ts';
import { resolveDetectionScope } from './scope.ts';
import { loadSpindriftFile } from './spindrift-file.ts';
import { deriveWatchPaths } from './watch-paths.ts';

export type { DetectionSource } from './scope.ts';

export type InferredComponentKind = Exclude<ComponentKind, 'job'>;

export type KindOption =
  | {
      readonly kind: ComponentKind;
      readonly available: true;
      readonly reason?: string;
    }
  | {
      readonly kind: ComponentKind;
      readonly available: false;
      readonly reason: string;
    };

export type ZeroConfigPlan =
  | {
      readonly outcome: 'detected';
      readonly kind: InferredComponentKind;
      readonly kinds: readonly KindOption[];
      readonly buildCommand: string | null;
      readonly outputDirectory: string | null;
    }
  | {
      readonly outcome: 'unsupported';
      readonly detail: string;
    };

/**
 * The Railpack-facing seam. A concrete process adapter belongs beside the build
 * routes; the detection ladder depends only on the stable facts it needs.
 */
export interface ZeroConfigPlanner {
  plan(directory: string): Promise<ZeroConfigPlan>;
}

export interface DetectionProposal {
  readonly source: 'railpack' | 'spindrift-file' | 'operator';
  readonly kind: ComponentKind;
  readonly kinds: readonly KindOption[];
  readonly build:
    | { readonly frontend: 'dockerfile'; readonly dockerfile: string }
    | {
        readonly frontend: 'railpack';
        readonly buildCommand: string | null;
        readonly outputDirectory: string | null;
      };
  readonly watchPaths: readonly string[];
}

export type DetectionResult =
  | {
      readonly outcome: 'detected';
      readonly scope: string;
      readonly proposal: DetectionProposal;
    }
  | {
      readonly outcome: 'unknown';
      readonly scope: string;
      readonly reason: 'unsupported';
      readonly detail: string;
      readonly watchPaths: readonly string[];
    };

export interface DetectScopeInput {
  readonly repositoryRoot: string;
  readonly source: DetectionSource;
  readonly planner: ZeroConfigPlanner;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function detectScope(
  input: DetectScopeInput,
): Promise<DetectionResult> {
  const { scope, directory } = await resolveDetectionScope(
    input.repositoryRoot,
    input.source,
  );

  const spindriftFile = join(directory, 'spindrift.yaml');
  if (input.source.kind === 'repo' && (await exists(spindriftFile))) {
    return {
      outcome: 'detected',
      scope,
      proposal: await loadSpindriftFile(spindriftFile),
    };
  }

  const watchPaths =
    input.source.kind === 'repo'
      ? await deriveWatchPaths(input.repositoryRoot, scope)
      : [];
  const plan = await input.planner.plan(directory);

  if (plan.outcome === 'unsupported') {
    return {
      outcome: 'unknown',
      scope,
      reason: 'unsupported',
      detail: plan.detail,
      watchPaths,
    };
  }

  const dockerfile = await exists(join(directory, 'Dockerfile'));
  return {
    outcome: 'detected',
    scope,
    proposal: {
      source: 'railpack',
      kind: plan.kind,
      kinds: plan.kinds,
      build: dockerfile
        ? { frontend: 'dockerfile', dockerfile: 'Dockerfile' }
        : {
            frontend: 'railpack',
            buildCommand: plan.buildCommand,
            outputDirectory: plan.outputDirectory,
          },
      watchPaths,
    },
  };
}
