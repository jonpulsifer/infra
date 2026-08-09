/**
 * One Component proposal from one explicitly named directory (§5).
 *
 * The zero-config builder owns language/framework detection. Core consumes a
 * normalized plan instead of duplicating those heuristics, then selects the
 * build frontend independently: a Dockerfile changes how code is built, never
 * what kind of Component it is.
 *
 * The ladder reads through a {@link SourceTree}, not a path. That is what lets
 * the same algorithm answer for an unpacked archive on a disk and for a
 * repository that has never been checked out — §5 says detection is one
 * algorithm, and one algorithm that only ran against one of its two sources
 * was one algorithm in name only.
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

/**
 * The planner seam. A concrete implementation belongs beside the thing that
 * plans; the ladder depends only on the stable facts it needs.
 */
export interface ZeroConfigPlanner {
  plan(tree: SourceTree, scope: string): Promise<ZeroConfigPlan>;
}

export interface DetectionProposal {
  readonly source: 'detection' | 'spindrift-file' | 'operator';
  readonly kind: ComponentKind;
  readonly kinds: readonly KindOption[];
  /**
   * Why this proposal says what it says.
   *
   * Not serialized into `spindrift.yaml`, for the same reason `kinds` is not
   * (see `serializeSpindriftFile`): it is a statement about how the answer was
   * reached, not about what this scope is, and writing it into the repository
   * would turn a sentence somebody read once into a value the next run has to
   * honour.
   */
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

/** The Spindrift file's name inside each scope (§5). */
const SPINDRIFT_FILE = 'spindrift.yaml';

function joinPath(scope: string, file: string): string {
  return scope === '.' ? file : `${scope}/${file}`;
}

/**
 * The sentence and the arrangement must agree (§5): the build routes probe the
 * same rule this proposal's context came from, so what this says is what the
 * build then does. A subpath scope names its context out loud, because the two
 * conventions only coincide at the root.
 */
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
  // Only a repo subpath has a root above it for the two conventions to
  // disagree about: an archive's prefix *is* its root.
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
