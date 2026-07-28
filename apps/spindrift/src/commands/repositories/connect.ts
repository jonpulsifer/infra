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
import { repositoryRefOf } from '../../domain/repository.ts';
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

const kindOption = z.object({
  kind: componentKind,
  available: z.boolean(),
  reason: z.string().optional(),
});

/**
 * The build half of a detection proposal, mirrored for untrusted input.
 *
 * §5's `DetectionProposal` is the authority on this shape; this is the gate that
 * lets a browser hand one over. The two are kept in step by
 * `configurationTransaction` taking the *domain* type — a drift between them is
 * a compile error at the call below, not a runtime surprise.
 */
const proposalBuild = z.discriminatedUnion('frontend', [
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

const proposal = z.object({
  source: z.enum(['railpack', 'spindrift-file']),
  kind: componentKind,
  kinds: z.array(kindOption),
  build: proposalBuild,
  watchPaths: z.array(scopePath).min(1),
});

export const connectRepositoryInput = z
  .object({
    fullName,
    /** The App installation this repository is reached through. */
    installationId: z.string().trim().min(1),
    /** One entry per App subpath the transaction will carry (§5, §15). */
    scopes: z
      .array(z.object({ scope: scopePath, proposal }))
      .min(1, 'a configuration pull request needs at least one scope'),
  })
  .strict();

/**
 * The domain shape, not `z.infer` of the schema above.
 *
 * The schema is the gate untrusted input passes through; the *type* is what the
 * command layer works in, and it is `ConfigurationScope` — §5's own
 * `DetectionProposal` — so that composing the transaction is a plain call
 * rather than a cast. A drift between the two is a compile error at that call.
 */
export type ConnectRepositoryInput = {
  readonly fullName: string;
  readonly installationId: string;
  readonly scopes: readonly ConfigurationScope[];
};

export interface ConnectRepositoryResult {
  readonly repositoryId: string;
  readonly fullName: string;
  readonly defaultBranch: string;
  /** The configuration pull request an operator now has to merge. */
  readonly pullRequest: number;
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

  // §15's transaction carries one CI caller, and the caller has to name a
  // pinned reusable workflow. An installation that has not published one has no
  // configuration PR to open — refused here rather than opened without the
  // caller, because a repository connected without a build route is connected
  // to nothing.
  const buildWorkflow = context.manifest.github.buildWorkflow;
  if (buildWorkflow === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has published no reusable build workflow, so there is no configuration pull request to open',
    );
  }

  const ref = repositoryRefOf({ installationId: input.installationId });

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
    throw cause;
  }

  const now = context.clock.now();
  const [row] = await context.db
    .insert(repositories)
    .values({
      fullName: input.fullName,
      installationId: input.installationId,
      defaultBranch,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: repositories.fullName,
      set: {
        installationId: input.installationId,
        defaultBranch,
        updatedAt: now,
      },
    })
    .returning();

  const transaction = configurationTransaction({
    scopes: input.scopes,
    buildWorkflow,
  });
  const opened = await openConfigurationPullRequest(host, ref, {
    fullName: input.fullName,
    defaultBranch,
    transaction,
  });

  await context.db
    .update(repositories)
    .set({ configPullRequest: opened.number, updatedAt: now })
    .where(eq(repositories.id, row!.id));

  return ok({
    repositoryId: row!.id,
    fullName: row!.fullName,
    defaultBranch,
    pullRequest: opened.number,
    authoritativeCommit: null,
  });
};
