/**
 * `inspectRepository` reads a repository and proposes what is deployable in it,
 * writing nothing. Every read is pinned to the default branch head, and a scope
 * nothing recognizes comes back `unsupported` with the reason.
 */
import { z } from 'zod';
import type { ComponentKind } from '../../domain/desired-state.ts';
import { declaredPlanner } from '../../domain/detection/declared.ts';
import { scanRepository } from '../../domain/detection/discover.ts';
import type { DetectionProposal } from '../../domain/detection/ladder.ts';
import { gitHubTree } from '../../domain/detection/tree.ts';
import { type Command, failed, ok } from '../types.ts';
import { unreadable } from './access.ts';

const fullName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name');

/** A repo-relative directory, `.` for the root. */
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
     * Omitted means the root, or what is below it when the root is not an App.
     */
    scopes: z.array(scopePath).max(24).optional(),
  })
  .strict();

export type InspectRepositoryInput = z.infer<typeof inspectRepositoryInput>;

export type InspectedScope =
  | {
      readonly scope: string;
      readonly outcome: 'detected';
      readonly kind: ComponentKind;
      readonly reason: string;
      readonly frontend: 'railpack' | 'dockerfile';
      /** Set only for the `dockerfile` frontend. */
      readonly dockerfile: string | null;
      /** Null when the ladder proposed none. */
      readonly buildCommand: string | null;
      /** Where a static rendering would lift files from, when there is one. */
      readonly outputDirectory: string | null;
      readonly watchPaths: readonly string[];
      /** True when an in-repo `spindrift.yaml` already settled this. */
      readonly configured: boolean;
      /** Each kind detection ruled out, with the sentence that ruled it out. */
      readonly unavailable: Readonly<Partial<Record<ComponentKind, string>>>;
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
   * False without a reusable build workflow, which the configuration PR needs.
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
    buildCommand:
      proposal.build.frontend === 'railpack'
        ? proposal.build.buildCommand
        : null,
    outputDirectory:
      proposal.build.frontend === 'railpack'
        ? proposal.build.outputDirectory
        : null,
    watchPaths: proposal.watchPaths,
    configured: proposal.source === 'spindrift-file',
    unavailable: Object.fromEntries(
      proposal.kinds
        .filter((option) => !option.available)
        .map((option) => [option.kind, option.reason]),
    ),
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
    return unreadable(input.fullName, cause);
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
    return unreadable(input.fullName, cause);
  }

  return ok({
    fullName: input.fullName,
    defaultBranch,
    commit,
    scopes,
    canConnect: (context.manifest.github?.buildWorkflow ?? null) !== null,
  });
};
