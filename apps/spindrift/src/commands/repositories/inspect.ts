/**
 * `inspectRepository` — read a repository and say what is deployable in it.
 *
 * This command writes nothing. It exists so that connecting a repository can be
 * a thing a developer *reads and confirms* rather than a form they fill in:
 * §5's ladder already knows how to turn one directory into one Component
 * proposal, and until now the only caller that could have asked it was a test.
 *
 * Two properties make it safe to run on a keystroke:
 *
 * - **It is pinned to a commit.** The default branch's head is resolved once and
 *   every read is against that sha, so what the screen shows and what
 *   `connectRepository` later writes are statements about the same code — even
 *   if somebody pushes in between, in which case the connect re-resolves and
 *   re-detects rather than writing a stale answer.
 * - **It is one tree read plus a handful of blobs.** No clone, no checkout, no
 *   builder. `gitHubTree` caches both, so inspecting five scopes in a monorepo
 *   costs one listing, not five.
 *
 * The unhappy path is a first-class result rather than an error: §5 makes "I do
 * not know how to build this" an outcome, and a repository where nothing is
 * recognized answers with an empty `scopes` and the reason each candidate was
 * passed over.
 */
import { z } from 'zod';
import type { ComponentKind } from '../../domain/desired-state.ts';
import { declaredPlanner } from '../../domain/detection/declared.ts';
import { scanRepository } from '../../domain/detection/discover.ts';
import type { DetectionProposal } from '../../domain/detection/ladder.ts';
import { gitHubTree } from '../../domain/detection/tree.ts';
import { GitHubAccessError } from '../../integrations/github/http.ts';
import { type Command, failed, ok } from '../types.ts';

/** `owner/name` — the only handle the repository API takes. */
const fullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name');

/** §5's named scope: a repo-relative directory, `.` for the root. */
const scopePath = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
    'must stay inside the repository',
  );

export const inspectRepositoryInput = z
  .object({
    fullName,
    /**
     * Directories to inspect. Omitted means: look at the root, and if the root
     * is not itself an App, discover what is below it.
     */
    scopes: z.array(scopePath).max(24).optional(),
  })
  .strict();

export type InspectRepositoryInput = z.infer<typeof inspectRepositoryInput>;

/** What one directory turned out to be. */
export type InspectedScope =
  | {
      readonly scope: string;
      readonly outcome: 'detected';
      readonly kind: ComponentKind;
      /** Why detection says so, in words a person reads on the screen. */
      readonly reason: string;
      readonly frontend: 'railpack' | 'dockerfile';
      /** Set only for the `dockerfile` frontend. */
      readonly dockerfile: string | null;
      /** Where a static rendering would lift files from, when there is one. */
      readonly outputDirectory: string | null;
      readonly watchPaths: readonly string[];
      /** True when an in-repo `spindrift.yaml` already settled this (§5). */
      readonly configured: boolean;
    }
  | {
      readonly scope: string;
      readonly outcome: 'unsupported';
      readonly detail: string;
    };

export interface InspectRepositoryResult {
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The exact revision every answer below is about. */
  readonly commit: string;
  readonly scopes: readonly InspectedScope[];
  /**
   * Whether this installation can open the configuration PR at all.
   *
   * §15 makes the pinned reusable workflow part of the transaction, so an
   * installation without one has nothing to connect a repository *to*. Said
   * here, on the screen that is about to offer the button, rather than
   * discovered by the button not working.
   */
  readonly canConnect: boolean;
}

function viewOf(scope: string, proposal: DetectionProposal): InspectedScope {
  return {
    scope,
    outcome: 'detected',
    kind: proposal.kind,
    reason: proposal.reason,
    frontend: proposal.build.frontend,
    dockerfile:
      proposal.build.frontend === 'dockerfile'
        ? proposal.build.dockerfile
        : null,
    outputDirectory:
      proposal.build.frontend === 'railpack'
        ? proposal.build.outputDirectory
        : null,
    watchPaths: proposal.watchPaths,
    configured: proposal.source === 'spindrift-file',
  };
}

export const inspectRepository: Command<
  InspectRepositoryInput,
  InspectRepositoryResult
> = async (input, context) => {
  const host = context.adapters.repository();
  if (host === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no repository integration, so nothing can be read from one',
    );
  }
  if (host.installationFor === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'this repository integration cannot discover installations, so nothing new can be inspected',
    );
  }

  let ref: Awaited<ReturnType<NonNullable<typeof host.installationFor>>>;
  let defaultBranch: string;
  let commit: string;
  try {
    ref = await host.installationFor(input.fullName);
    ({ defaultBranch } = await host.repository(ref, input.fullName));
    commit = await host.branchHead(ref, input.fullName, defaultBranch);
  } catch (cause) {
    if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
      return failed(
        'NOT_FOUND',
        `Spindrift cannot reach ${input.fullName}: authorize GitHub and check that the App installation selects it`,
      );
    }
    return failed(
      'NOT_FOUND',
      `Spindrift cannot reach ${input.fullName}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let scopes: readonly InspectedScope[];
  try {
    const found = await scanRepository(
      gitHubTree(host, ref, input.fullName, commit),
      declaredPlanner(),
      input.scopes,
    );
    scopes = found.map((result) =>
      result.outcome === 'detected'
        ? viewOf(result.scope, result.proposal)
        : {
            scope: result.scope,
            outcome: 'unsupported' as const,
            detail: result.detail,
          },
    );
  } catch (cause) {
    if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
      return failed(
        'NOT_FOUND',
        `Spindrift lost access to ${input.fullName} while reading it`,
      );
    }
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift could not read ${input.fullName} at ${commit.slice(0, 7)}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }

  return ok({
    fullName: input.fullName,
    defaultBranch,
    commit,
    scopes,
    canConnect: (context.manifest.github?.buildWorkflow ?? null) !== null,
  });
};
