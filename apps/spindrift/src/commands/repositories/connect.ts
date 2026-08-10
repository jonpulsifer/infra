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
    /**
     * Which directories the transaction covers, and nothing about them.
     *
     * §5's ladder is what turns a directory into a proposal, and it runs
     * **here**, against the commit this connect resolves — not in the browser.
     * The screen has already shown the operator what detection found; sending
     * that answer back to be written would make the browser the author of
     * domain state and would write whatever was on screen when the tab was
     * opened, which is not necessarily what is on the default branch now.
     *
     * Omitted entirely means the same thing `inspectRepository` means by it:
     * the root, or what is below it when the root is not itself an App.
     */
    scopes: z.array(scopePath).min(1).max(24).optional(),
    /**
     * The escape hatch (story 32): assert the proposal instead of detecting it.
     *
     * Kept separate from `scopes` rather than making every field optional on
     * one shape, because these two are different acts. One says "connect what
     * you found"; the other says "I know better than the detector, and here is
     * what to write". A half-filled mixture of the two is not a third act, and
     * the schema declines to represent it.
     */
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
  /** The configuration pull request an operator now has to merge, or null if PR creation failed. */
  readonly pullRequest: number | null;
  /**
   * Why `pullRequest` is null, when it is. The repository stays connected
   * either way — the repo loop reads the default branch, not the PR — but a
   * connection whose PR silently never opened reads exactly like one whose PR
   * opened fine, and the operator deserves the difference.
   */
  readonly pullRequestError: string | null;
  /** Always null: nothing is authoritative before that merge (§15). */
  readonly authoritativeCommit: null;
}

/**
 * What the transaction will carry: detection's answer, or the operator's.
 *
 * The two arms are the two acts the input schema separates. An override is
 * written exactly as asserted and marked `operator`, so the pull request's
 * "proposed by" column tells a reviewer that a human, not the detector, chose
 * this — which is the difference that matters when the review is about whether
 * to trust it.
 *
 * Unsupported scopes are dropped rather than refused. A monorepo with nine
 * directories and two Apps is the ordinary case, and failing the connect
 * because seven of them are libraries would make discovery useless. The caller
 * refuses only when *nothing* survived.
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
    // No commit is resolved on this path, and that is not an optimization: an
    // asserted proposal is a statement about what the operator wants written,
    // not about what is currently on the branch. Reading the repository to
    // write it would add a way for this act to fail that has nothing to do
    // with what it does.
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

  // Resolved here rather than taken as a parameter, because it is what
  // detection reads and what the pull request will be a statement about. A
  // repository that moved between the operator seeing the inspection and
  // pressing the button is connected against what is on the branch **now**.
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

  // §15's transaction carries one CI caller, and the caller has to name the
  // manifest's reusable workflow. An installation that has not published one has no
  // configuration PR to open — refused here rather than opened without the
  // caller, because a repository connected without a build route is connected
  // to nothing. The manifest schema says this refusal out loud ("null means
  // repositories cannot be connected"), and `inspectRepository` answers
  // `canConnect: false` for the same reason, so the button that reaches this
  // path is already disabled.
  const buildWorkflow = context.manifest.github?.buildWorkflow ?? null;
  if (buildWorkflow === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has published no reusable build workflow (github.buildWorkflow), so there is no CI caller to write into the configuration pull request; publish one, then connect again',
    );
  }

  // Every read below refuses through the one taxonomy (`access.ts`): §15's
  // lost-access rule reaches back to here — a repository the App cannot see is
  // a fact about the world, reported as a refusal the operator can act on,
  // never an exception the dispatch surface turns into a 500 — and the other
  // two codes are not that fact. The creation wizard reaches this command with
  // a repository it has just read successfully, so an hour's quota answering
  // "cannot reach" would contradict the screen that offered the button.
  let ref: ReturnType<typeof repositoryRefOf>;
  try {
    ref = await host.installationFor(input.fullName);
  } catch (cause) {
    return unreadable(input.fullName, cause);
  }

  let defaultBranch: string;
  try {
    ({ defaultBranch } = await host.repository(ref, input.fullName));
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
    // Nothing is written, deliberately. A `repositories` row with no scope is a
    // connection to nothing: the repo loop would adopt it, find no App, and
    // reconcile forever over a repository that cannot produce a Build. §5 makes
    // "I do not know how to build this" an outcome to state, and this is where
    // it gets stated — before a row exists rather than after.
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
  let pullRequestError: string | null = null;
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
  } catch (cause) {
    // Fail open: the repository stays connected and the repo loop still adopts
    // its default branch; only the PR is lost, and the result says which and
    // why rather than leaving `pullRequest: null` to mean three different
    // things.
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
