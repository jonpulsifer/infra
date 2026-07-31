/**
 * `connectRepository` — turn on Git integration for one repository (§15).
 *
 * §15 makes this act one thing an operator reviews: "**One human-editable
 * configuration PR per repository is the transaction**." So the command writes
 * one `repositories` row, opens one pull request, and stops. In particular it
 * **adopts nothing** — `authoritativeCommit` stays null until the repo loop
 * reads a default-branch commit, which is what makes user story 19 ("only the
 * default-branch merge becomes authoritative") a property of the schema rather
 * than of anybody's discipline. The result says so out loud.
 *
 * Connecting twice is the same act twice. The row is keyed on the repository's
 * full name and re-adopted rather than duplicated, and the configuration branch
 * is force-updated to the newly composed transaction — a second connection is
 * somebody correcting the first, and leaving the old branch in place would
 * leave them reviewing a pull request that no longer says what Spindrift
 * thinks.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { repositories } from '../../db/schema.ts';
import type { repositoryRefOf } from '../../domain/repository.ts';
import {
  type ConfigurationScope,
  configurationTransaction,
  openConfigurationPullRequest,
} from '../../integrations/github/config-pr.ts';
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

/** §2: "kind = service | website | job". */
const componentKind = z.enum(['service', 'website', 'job']);

/**
 * The operator's build selection. The command turns it into §5's canonical
 * proposal; the browser never constructs domain state.
 */
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
    /** One entry per App subpath the transaction will carry (§5, §15). */
    scopes: z
      .array(
        z.object({
          scope: scopePath,
          kind: componentKind,
          build: operatorBuild,
          watchPaths: z.array(scopePath).min(1),
        }),
      )
      .min(1, 'a configuration pull request needs at least one scope'),
  })
  .strict();

export type ConnectRepositoryInput = z.infer<typeof connectRepositoryInput>;

export interface ConnectRepositoryResult {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The configuration pull request an operator now has to merge, or null if PR creation failed. */
  readonly pullRequest: number | null;
  /** Always null: nothing is authoritative before that merge (§15). */
  readonly authoritativeCommit: null;
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

  // §15's transaction carries one CI caller, and the caller has to name a
  // pinned reusable workflow. An installation that has not published one has no
  // configuration PR to open — refused here rather than opened without the
  // caller, because a repository connected without a build route is connected
  // to nothing.
  const buildWorkflow = context.manifest.github?.buildWorkflow ?? null;

  let ref: ReturnType<typeof repositoryRefOf>;
  try {
    ref = await host.installationFor(input.fullName);
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

  let defaultBranch: string;
  try {
    ({ defaultBranch } = await host.repository(ref, input.fullName));
  } catch (cause) {
    // §15's lost-access rule reaches back to here: a repository the App cannot
    // see is a fact about the world, reported as a refusal the operator can act
    // on, never an exception the dispatch surface turns into a 500.
    if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
      return failed(
        'NOT_FOUND',
        `Spindrift cannot reach ${input.fullName}: check that the App installation still selects it`,
      );
    }
    return failed(
      'NOT_FOUND',
      `Spindrift cannot reach ${input.fullName}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const now = context.clock.now();
  const [row] = await context.db
    .insert(repositories)
    .values({
      fullName: input.fullName,
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
        updatedAt: now,
      },
    })
    .returning();

  let pullRequest: number | null = null;
  if (buildWorkflow !== null) {
    const scopes: ConfigurationScope[] = input.scopes.map(
      ({ scope, kind, build, watchPaths }) => ({
        scope,
        proposal: {
          source: 'operator',
          kind,
          kinds: (['service', 'website', 'job'] as const).map((candidate) =>
            candidate === kind
              ? { kind: candidate, available: true }
              : {
                  kind: candidate,
                  available: false,
                  reason: 'the operator selected another kind',
                },
          ),
          build,
          watchPaths,
        },
      }),
    );
    const transaction = configurationTransaction({
      scopes,
      buildWorkflow,
    });

    try {
      const opened = await openConfigurationPullRequest(host, ref, {
        fullName: input.fullName,
        defaultBranch,
        transaction,
      });
      pullRequest = opened.number;
      await context.db
        .update(repositories)
        .set({ configPullRequest: opened.number, updatedAt: now })
        .where(eq(repositories.id, row!.id));
    } catch {
      // Fail open: opening the configuration PR failed (e.g. GitHub permission or API error),
      // but the repository remains connected.
    }
  }

  return ok({
    repositoryId: row!.id,
    fullName: row!.fullName,
    defaultBranch,
    pullRequest,
    authoritativeCommit: null,
  });
};
