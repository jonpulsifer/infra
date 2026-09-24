/**
 * One Component proposal from one named directory, read through a
 * {@link SourceTree} so an archive and an unchecked-out repository share it. A
 * Dockerfile changes how code is built, never what kind of Component it is.
 */
import type { ComponentKind } from '../desired-state.ts';
import {
  type DockerfileBuildContext,
  dockerfileBuildContext,
} from './dockerfile-context.ts';
import type { DetectionSource } from './scope.ts';
import { resolveDetectionScope } from './scope.ts';
import { parseSpindriftFile } from './spindrift-file.ts';
import { exists, type SourceTree } from './tree.ts';
import { deriveWatchPaths } from './watch-paths.ts';

export type { DetectionSource } from './scope.ts';
export type { SourceTree } from './tree.ts';

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
      /** One sentence naming what produced this, in a human's words. */
      readonly reason: string;
      readonly buildCommand: string | null;
      readonly outputDirectory: string | null;
    }
  | {
      readonly outcome: 'unsupported';
      readonly detail: string;
    };

export interface ZeroConfigPlanner {
  plan(tree: SourceTree, scope: string): Promise<ZeroConfigPlan>;
}

export interface DetectionProposal {
  readonly source: 'detection' | 'spindrift-file' | 'operator';
  readonly kind: ComponentKind;
  readonly kinds: readonly KindOption[];
  /** Never written to `spindrift.yaml`: it says how the answer was reached, not what the scope is. */
  readonly reason: string;
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
  readonly tree: SourceTree;
  readonly source: DetectionSource;
  readonly planner: ZeroConfigPlanner;
}

const SPINDRIFT_FILE = 'spindrift.yaml';

function joinPath(scope: string, file: string): string {
  return scope === '.' ? file : `${scope}/${file}`;
}

/** Names the build context for a subpath scope, where the two conventions differ. */
function dockerfileSentence(
  scope: string,
  context: DockerfileBuildContext,
): string {
  if (context.context === 'scope') {
    return `built from the Dockerfile in this directory, which copies ${context.copies} from beside itself, so this directory is the build context`;
  }
  return scope === '.'
    ? 'built from the Dockerfile in this directory'
    : 'built from the Dockerfile in this directory, with the repository root as the build context';
}

export async function detectScope(
  input: DetectScopeInput,
): Promise<DetectionResult> {
  const { tree, source, planner } = input;
  const { scope, prefix } = await resolveDetectionScope(tree, source);

  if (source.kind === 'repo') {
    const document = await tree.readText(joinPath(prefix, SPINDRIFT_FILE));
    if (document !== null) {
      return {
        outcome: 'detected',
        scope,
        proposal: parseSpindriftFile(
          document,
          joinPath(prefix, SPINDRIFT_FILE),
        ),
      };
    }
  }

  const watchPaths =
    source.kind === 'repo' ? await deriveWatchPaths(tree, scope) : [];
  const plan = await planner.plan(tree, prefix);

  if (plan.outcome === 'unsupported') {
    return {
      outcome: 'unknown',
      scope,
      reason: 'unsupported',
      detail: plan.detail,
      watchPaths,
    };
  }

  const dockerfile = await exists(tree, joinPath(prefix, 'Dockerfile'));
  // An archive's prefix is its root, so only a repo subpath can differ.
  const context: DockerfileBuildContext =
    dockerfile && source.kind === 'repo'
      ? await dockerfileBuildContext(tree, prefix)
      : { context: 'root' };
  return {
    outcome: 'detected',
    scope,
    proposal: {
      source: 'detection',
      kind: plan.kind,
      kinds: plan.kinds,
      reason: dockerfile
        ? `${plan.reason}; ${dockerfileSentence(scope, context)}`
        : plan.reason,
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
