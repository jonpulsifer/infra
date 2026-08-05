/**
 * The repository loop (§15).
 *
 * §15 gives Spindrift "a signed repository webhook **plus** periodic
 * default-branch reconciliation", and says why: "so that a missed delivery
 * self-heals". This file is the second half, and it is the correctness path —
 * the webhook only shortens a wait. Everything here is correct with every
 * delivery dropped, exactly as the deploy loop is correct with every
 * `NOTIFY` dropped, and for the same reason: an endpoint on the public
 * internet is not a delivery guarantee.
 *
 * Three rules run through it.
 *
 * **Only the default branch is authoritative.** Configuration is adopted from
 * one commit on one branch, and `repositories.authoritative_commit` is where
 * that lands. A pull request — including the configuration PR Spindrift itself
 * opened — is on a branch, so nothing this loop does can be affected by one
 * until it merges. That is not a code path to be careful about; it is that
 * there is no code path reading any other ref.
 *
 * **The repository's configuration is one transaction.** §15 makes the whole
 * PR the unit, so a default-branch commit carrying an unparseable Spindrift
 * file is a commit that is **not adopted at all** — the good scopes in it do
 * not land while a bad one is ignored. The loop reports why and tries again on
 * the next pass, which is what turns a typo into a visible, self-clearing state
 * rather than a partial adoption nobody can see.
 *
 * **Lost access freezes and never destroys.** §15: "Lost access **freezes
 * source-driven changes and never destroys a Deploy**." Mechanically: the only
 * write this file makes on lost access is an `UPDATE` of one `repositories`
 * row. There is no `delete` anywhere in it, and no write to `apps`,
 * `components`, `builds`, or `deploys` at all — so what is running keeps
 * running, and what stops is the one thing that genuinely cannot continue,
 * which is reading new source.
 *
 * What this file's own functions do **not** do is dispatch a build or a
 * Deploy. `reconcileRepository`, `reconcileAllRepositories`, and
 * `applyWebhookDelivery` end at adopting a commit and saying which scopes it
 * changed — `./auto-deploy.ts`'s `dispatchAutoDeploys` is the dispatcher that
 * fact was always for. It reads the `RepositoryReconciliation[]` these
 * functions return and, for every App on the repository that opted in
 * (`apps.autoDeploy`), calls `deployApp`. Both the poll loop's periodic pass
 * and the webhook route call it over the same passes, which is what keeps a
 * missed delivery self-healing rather than silently skipping a deploy: the
 * loop's next tick reconciles the same commit and dispatches exactly as the
 * webhook would have.
 */
import { eq } from 'drizzle-orm';
import type { Clock } from '../commands/types.ts';
import type { Database } from '../db/client.ts';
import { apps, type Repository, repositories } from '../db/schema.ts';
import type { DetectionProposal } from '../domain/detection/ladder.ts';
import { parseSpindriftFile } from '../domain/detection/spindrift-file.ts';
import {
  type RepositoryReader,
  type RepositoryRef,
  repositoryRefOf,
} from '../domain/repository.ts';
import { SPINDRIFT_FILE } from '../integrations/github/config-pr.ts';
import { GitHubAccessError } from '../integrations/github/http.ts';
import type { WebhookDelivery } from '../integrations/github/webhook.ts';
import { reconcilerLoopDuration } from '../telemetry/index.ts';

/** What the loop needs. No principal: nobody asked for it to run. */
export interface RepoLoopContext {
  readonly db: Database;
  readonly clock: Clock;
  /**
   * The far side, as the domain names it — never a GitHub client. The loop
   * reads three things and writes none, which is what `RepositoryReader` is.
   */
  readonly host: RepositoryReader;
}

/** What one scope's Spindrift file said, or why it said nothing. */
export type ScopeOutcome =
  | {
      readonly scope: string;
      readonly appId: string;
      readonly outcome: 'adopted';
      readonly proposal: DetectionProposal;
      /** Whether this differs from what the previously adopted commit held. */
      readonly changed: boolean;
    }
  | {
      readonly scope: string;
      readonly appId: string;
      /** No Spindrift file at this scope. Not an error: detection still applies. */
      readonly outcome: 'absent';
    }
  | {
      readonly scope: string;
      readonly appId: string;
      readonly outcome: 'invalid';
      readonly detail: string;
    };

/** What one pass over one repository did. */
export type RepositoryReconciliation =
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /** The default branch had not moved since the adopted commit. */
      readonly outcome: 'unchanged';
      readonly commit: string;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      readonly outcome: 'adopted';
      readonly commit: string;
      readonly scopes: readonly ScopeOutcome[];
      /** Set when this pass also cleared a freeze. */
      readonly thawed?: true;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /** A commit was reached but not adopted: a scope's file did not parse. */
      readonly outcome: 'rejected';
      readonly commit: string;
      readonly scopes: readonly ScopeOutcome[];
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      readonly outcome: 'frozen';
      readonly detail: string;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /**
       * The host could not be reached, or refused for a reason that is not
       * about access. Explicitly **not** a freeze: a rate limit or a bad hour
       * at the far side is a delay, and turning it into an operator-visible
       * frozen state would cry wolf until nobody read the state at all.
       */
      readonly outcome: 'unavailable';
      readonly detail: string;
    };

/** Where a scope's Spindrift file lives. `.` is the repository root (§5). */
function spindriftPath(subpath: string | null): string {
  const scope = subpath ?? '.';
  return scope === '.' ? SPINDRIFT_FILE : `${scope}/${SPINDRIFT_FILE}`;
}

/**
 * Freeze one repository (§15).
 *
 * One `UPDATE`, and the row it touches is the only row in the database that
 * describes source access. Nothing about what is deployed is reachable from
 * here, which is the mechanical form of "never destroys a Deploy".
 */
async function freeze(
  context: RepoLoopContext,
  repository: Pick<Repository, 'id' | 'fullName'>,
  detail: string,
): Promise<RepositoryReconciliation> {
  const now = context.clock.now();
  await context.db
    .update(repositories)
    .set({
      access: 'frozen',
      frozenReason: detail,
      frozenAt: now,
      updatedAt: now,
    })
    .where(eq(repositories.id, repository.id));

  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    outcome: 'frozen',
    detail,
  };
}

/** Clear a freeze. Source-driven changes resume; nothing else changes. */
async function thaw(
  context: RepoLoopContext,
  repositoryId: string,
): Promise<void> {
  const now = context.clock.now();
  await context.db
    .update(repositories)
    .set({
      access: 'active',
      frozenReason: null,
      frozenAt: null,
      updatedAt: now,
    })
    .where(eq(repositories.id, repositoryId));
}

/**
 * One pass over one repository.
 *
 * Never throws for anything the far side did. A loop over a fleet has to
 * survive one bad repository, and an access error is the input to a decision
 * here rather than an exception somebody above has to interpret.
 */
export async function reconcileRepository(
  context: RepoLoopContext,
  repository: Repository,
): Promise<RepositoryReconciliation> {
  const ref = repositoryRefOf(repository);
  const now = context.clock.now();

  let defaultBranch: string;
  let head: string;
  try {
    const facts = await context.host.repository(ref, repository.fullName);
    defaultBranch = facts.defaultBranch;
    head = await context.host.branchHead(
      ref,
      repository.fullName,
      defaultBranch,
    );
  } catch (cause) {
    if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
      return freeze(
        context,
        repository,
        'Spindrift can no longer read this repository',
      );
    }
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unavailable',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Reaching the repository is what proves access came back. A freeze is
  // cleared here rather than only on a webhook, because §15's periodic
  // reconciliation is the path that has to work when a delivery was missed —
  // including the delivery that would have said access was restored.
  const thawed = repository.access === 'frozen';
  if (thawed) await thaw(context, repository.id);

  if (head === repository.authoritativeCommit) {
    await context.db
      .update(repositories)
      .set({ defaultBranch, reconciledAt: now, updatedAt: now })
      .where(eq(repositories.id, repository.id));
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unchanged',
      commit: head,
    };
  }

  const scoped = await context.db
    .select({
      id: apps.id,
      subpath: apps.sourceRepoSubpath,
    })
    .from(apps)
    .where(eq(apps.repositoryId, repository.id));

  const previous = repository.authoritativeCommit;
  const outcomes: ScopeOutcome[] = [];
  for (const app of scoped) {
    const scope = app.subpath ?? '.';
    const path = spindriftPath(app.subpath);
    let document: string | null;
    try {
      document = await context.host.readFile(
        ref,
        repository.fullName,
        head,
        path,
      );
    } catch (cause) {
      if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
        return freeze(
          context,
          repository,
          'Spindrift can no longer read this repository',
        );
      }
      return {
        repositoryId: repository.id,
        fullName: repository.fullName,
        outcome: 'unavailable',
        detail: cause instanceof Error ? cause.message : String(cause),
      };
    }

    if (document === null) {
      outcomes.push({ scope, appId: app.id, outcome: 'absent' });
      continue;
    }

    let proposal: DetectionProposal;
    try {
      proposal = parseSpindriftFile(document, path);
    } catch (cause) {
      outcomes.push({
        scope,
        appId: app.id,
        outcome: 'invalid',
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      continue;
    }

    let changed = true;
    if (previous !== null) {
      // "Changed" is a comparison against the previously adopted commit, not a
      // guess from the push payload's file list: a force-push, a revert, and a
      // merge all move the branch without saying what a scope's file now says.
      const before = await readScopeFile(
        context,
        ref,
        repository,
        previous,
        path,
      );
      changed = before !== document;
    }

    outcomes.push({
      scope,
      appId: app.id,
      outcome: 'adopted',
      proposal,
      changed,
    });
  }

  if (outcomes.some((outcome) => outcome.outcome === 'invalid')) {
    // Not adopted, and `authoritative_commit` deliberately left where it was:
    // the previous commit's configuration is still what governs, and the next
    // pass will try this one again.
    await context.db
      .update(repositories)
      .set({ defaultBranch, reconciledAt: now, updatedAt: now })
      .where(eq(repositories.id, repository.id));
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'rejected',
      commit: head,
      scopes: outcomes,
    };
  }

  await context.db
    .update(repositories)
    .set({
      defaultBranch,
      authoritativeCommit: head,
      reconciledAt: now,
      updatedAt: now,
    })
    .where(eq(repositories.id, repository.id));

  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    outcome: 'adopted',
    commit: head,
    scopes: outcomes,
    ...(thawed ? { thawed: true as const } : {}),
  };
}

/** A scope's file at an older commit, or `null` if it was not there either. */
async function readScopeFile(
  context: RepoLoopContext,
  ref: RepositoryRef,
  repository: Repository,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    return await context.host.readFile(ref, repository.fullName, commit, path);
  } catch {
    // A commit that has been garbage-collected, or a history rewrite. Not
    // knowing what a scope looked like before is a reason to treat it as
    // changed, never a reason to fail the pass.
    return null;
  }
}

/**
 * One pass over every connected repository.
 *
 * Frozen repositories are **included**, not skipped. A freeze is a state to
 * recover from, and the only thing that can observe recovery is an attempt to
 * read — so skipping them would make a freeze permanent until somebody noticed
 * by hand.
 */
export async function reconcileAllRepositories(
  context: RepoLoopContext,
): Promise<readonly RepositoryReconciliation[]> {
  const connected = await context.db.select().from(repositories);

  const passes: RepositoryReconciliation[] = [];
  for (const repository of connected) {
    // Sequential: the far side is somebody else's API with a shared rate limit,
    // and a fleet of repositories reconciling in lockstep is the fastest way to
    // spend an hour's quota in a second.
    passes.push(await reconcileRepository(context, repository));
  }
  return passes;
}

/**
 * Apply one **already verified** webhook delivery.
 *
 * A shortcut, never a source of truth. Every branch here either does what the
 * periodic pass would have done anyway, or does nothing — so a delivery that
 * never arrives costs latency and nothing else.
 */
export async function applyWebhookDelivery(
  context: RepoLoopContext,
  delivery: WebhookDelivery,
): Promise<readonly RepositoryReconciliation[]> {
  if (delivery.kind === 'ignored') return [];

  if (delivery.kind === 'push') {
    // §15: only the default branch is authoritative. A push to any other ref is
    // discarded here rather than reconciled-and-discarded, because reconciling
    // would read the default branch and find nothing new — the same answer, one
    // round trip later.
    if (delivery.ref !== `refs/heads/${delivery.defaultBranch}`) return [];
    const [repository] = await context.db
      .select()
      .from(repositories)
      .where(eq(repositories.fullName, delivery.repository));
    if (repository === undefined) return [];
    return [await reconcileRepository(context, repository)];
  }

  const affected = await repositoriesOf(
    context,
    delivery.installationId,
    delivery.repositories,
  );

  if (delivery.kind === 'accessLost') {
    const frozen: RepositoryReconciliation[] = [];
    for (const repository of affected) {
      frozen.push(await freeze(context, repository, delivery.detail));
    }
    return frozen;
  }

  // Restored access is not taken at the delivery's word: the freeze is cleared
  // by a pass that actually read the repository, which is the same evidence the
  // periodic path uses.
  const passes: RepositoryReconciliation[] = [];
  for (const repository of affected) {
    passes.push(await reconcileRepository(context, repository));
  }
  return passes;
}

/**
 * The rows one installation-scoped delivery names.
 *
 * An empty name list means the whole installation — a deletion or a suspension
 * names no repository because it applies to all of them.
 */
async function repositoriesOf(
  context: RepoLoopContext,
  installationId: string,
  names: readonly string[],
): Promise<Repository[]> {
  const all = await context.db
    .select()
    .from(repositories)
    .where(eq(repositories.installationId, installationId));
  if (names.length === 0) return all;

  const named = new Set(names);
  return all.filter((repository) => named.has(repository.fullName));
}

/** How often the loop runs, and how to stop it. */
export interface RepoLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  /**
   * Called after each pass — where an installation wires logging, metrics, or
   * `./auto-deploy.ts`'s `dispatchAutoDeploys`. May return a `Promise`, which
   * the loop awaits before sleeping: dispatch is a database write and the
   * loop's shutdown signal must not race ahead of it.
   */
  readonly onPass?: (
    passes: readonly RepositoryReconciliation[],
  ) => void | Promise<void>;
}

/**
 * Run the loop until aborted.
 *
 * The interval is fixed rather than adaptive, unlike the deploy loop's. There
 * is no in-flight window here to be fast for: a repository is either at its
 * adopted commit or it is not, and the webhook is what covers the latency the
 * interval would otherwise be shortened for.
 */
export async function runRepoLoop(
  context: RepoLoopContext,
  options: RepoLoopOptions,
): Promise<void> {
  while (!options.signal?.aborted) {
    const startedAt = Date.now();
    const passes = await reconcileAllRepositories(context);
    reconcilerLoopDuration.record((Date.now() - startedAt) / 1000, {
      loop: 'repository',
    });
    await options.onPass?.(passes);
    if (options.signal?.aborted) return;
    await sleep(options.intervalMs, options.signal);
  }
}

/** A sleep that wakes early on abort rather than holding the loop open. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
