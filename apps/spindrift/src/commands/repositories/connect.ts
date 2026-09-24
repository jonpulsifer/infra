/**
 * `connectRepository` writes one `repositories` row and opens one configuration
 * pull request. It adopts nothing; the repo loop or creation adopts the default
 * branch afterwards. Connecting again re-adopts the row and rewrites the branch.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { repositories } from '../../db/schema.ts';
import { declaredPlanner } from '../../domain/detection/declared.ts';
import { scanRepository } from '../../domain/detection/discover.ts';
import { gitHubTree } from '../../domain/detection/tree.ts';
import type {
  RepositoryHost,
  RepositoryRef,
  repositoryRefOf,
} from '../../domain/repository.ts';
import {
  type ConfigurationScope,
  configurationTransaction,
  openConfigurationPullRequest,
} from '../../integrations/github/config-pr.ts';
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

const componentKind = z.enum(['service', 'website', 'job']);

const operatorBuild = z.discriminatedUnion('frontend', [
  z.object({
    frontend: z.literal('dockerfile'),
    dockerfile: scopePath,
  }),
  z.object({
    frontend: z.literal('railpack'),
    buildCommand: z.string().min(1).nullable(),
    outputDirectory: z.string().min(1).nullable(),
  }),
]);

export const connectRepositoryInput = z
  .object({
    fullName,
    /**
     * Detection runs here, against the commit this connect resolves. Omitted
     * means the root, or what is below it when the root is not an App.
     */
    scopes: z.array(scopePath).min(1).max(24).optional(),
    /** Asserts the proposal instead of detecting it. */
    overrides: z
      .array(
        z.object({
          scope: scopePath,
          kind: componentKind,
          build: operatorBuild,
          watchPaths: z.array(scopePath).min(1),
        }),
      )
      .min(1)
      .optional(),
  })
  .strict();

export type ConnectRepositoryInput = z.infer<typeof connectRepositoryInput>;

export interface ConnectRepositoryResult {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The configuration pull request to merge; null when opening it failed. */
  readonly pullRequest: number | null;
  /** Why `pullRequest` is null. The repository stays connected either way. */
  readonly pullRequestError: string | null;
  /** Always null: this command adopts nothing. */
  readonly authoritativeCommit: null;
}

/**
 * Detection's proposals, or the operator's overrides marked `operator`. Scopes
 * detection cannot build are dropped; the caller refuses when none survive.
 */
async function configurationScopes(
  input: ConnectRepositoryInput,
  host: RepositoryHost,
  ref: RepositoryRef,
  defaultBranch: string,
): Promise<{
  readonly scopes: ConfigurationScope[];
  /** The revision detection read, or null when nothing needed reading. */
  readonly commit: string | null;
}> {
  if (input.overrides !== undefined) {
    // An override states what to write, so the branch is not read.
    return {
      commit: null,
      scopes: input.overrides.map(({ scope, kind, build, watchPaths }) => ({
        scope,
        proposal: {
          source: 'operator' as const,
          kind,
          reason: `an operator asserted this scope is a ${kind}`,
          kinds: (['service', 'website', 'job'] as const).map((candidate) =>
            candidate === kind
              ? { kind: candidate, available: true as const }
              : {
                  kind: candidate,
                  available: false as const,
                  reason: 'the operator selected another kind',
                },
          ),
          build,
          watchPaths,
        },
      })),
    };
  }

  // Resolved now, so a branch that moved since the inspection is read as it is.
  const commit = await host.branchHead(ref, input.fullName, defaultBranch);
  const found = await scanRepository(
    gitHubTree(host, ref, input.fullName, commit),
    declaredPlanner(),
    input.scopes,
  );
  return {
    commit,
    scopes: found.flatMap((result) =>
      result.outcome === 'detected'
        ? [{ scope: result.scope, proposal: result.proposal }]
        : [],
    ),
  };
}

export const connectRepository: Command<
  ConnectRepositoryInput,
  ConnectRepositoryResult
> = async (input, context) => {
  const host = context.adapters.repository();
  if (host === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no repository integration, so nothing can be connected to one',
    );
  }
  if (host.installationFor === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'this repository integration cannot discover installations, so nothing new can be connected',
    );
  }

  // The configuration PR's CI caller names this workflow; without one there is
  // no build route to connect to, and inspectRepository says so up front.
  const buildWorkflow = context.manifest.github?.buildWorkflow ?? null;
  if (buildWorkflow === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has published no reusable build workflow (github.buildWorkflow), so there is no CI caller to write into the configuration pull request; publish one, then connect again',
    );
  }

  // Each read refuses through `unreadable`: lost access is a refusal, not a 500.
  let ref: ReturnType<typeof repositoryRefOf>;
  try {
    ref = await host.installationFor(input.fullName);
  } catch (cause) {
    return unreadable(input.fullName, cause);
  }

  // Keyed on the host's spelling, which the repo loop also writes: the host
  // ignores case and follows renames, and the unique index does neither.
  let fullName: string;
  let defaultBranch: string;
  try {
    ({ fullName, defaultBranch } = await host.repository(ref, input.fullName));
  } catch (cause) {
    return unreadable(input.fullName, cause);
  }

  let scopes: ConfigurationScope[];
  let commit: string | null;
  try {
    ({ scopes, commit } = await configurationScopes(
      input,
      host,
      ref,
      defaultBranch,
    ));
  } catch (cause) {
    return unreadable(input.fullName, cause);
  }

  if (scopes.length === 0) {
    // No row: the repo loop would reconcile a scopeless one forever.
    const at = commit === null ? '' : ` at ${commit.slice(0, 7)}`;
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift found nothing it knows how to build in ${input.fullName}${at}. Add a spindrift.yaml or a Dockerfile to the directory you want deployed, then connect it again.`,
    );
  }

  const now = context.clock.now();
  const [row] = await context.db
    .insert(repositories)
    .values({
      fullName,
      installationId: ref.installationId,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repositories.fullName,
      set: {
        installationId: ref.installationId,
        defaultBranch,
        // The reads above just proved access, so any freeze is cleared now
        // instead of lasting a repo-loop interval.
        access: 'active',
        frozenReason: null,
        frozenAt: null,
        updatedAt: now,
      },
    })
    .returning();

  let pullRequest: number | null = null;
  let pullRequestError: string | null = null;
  const transaction = configurationTransaction({
    scopes,
    buildWorkflow,
  });

  try {
    const opened = await openConfigurationPullRequest(host, ref, {
      fullName,
      defaultBranch,
      transaction,
    });
    pullRequest = opened.number;
    await context.db
      .update(repositories)
      .set({ configPullRequest: opened.number, updatedAt: now })
      .where(eq(repositories.id, row!.id));
  } catch (cause) {
    // Fail open: the repository stays connected, and the result says why.
    pullRequestError = cause instanceof Error ? cause.message : String(cause);
  }

  return ok({
    repositoryId: row!.id,
    fullName: row!.fullName,
    defaultBranch,
    pullRequest,
    pullRequestError,
    authoritativeCommit: null,
  });
};
