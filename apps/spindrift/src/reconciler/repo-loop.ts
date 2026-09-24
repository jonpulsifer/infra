/**
 * Reconciles each repository's default branch into `authoritative_commit`: the
 * correctness path behind the webhook. Lost access freezes the repository row
 * and never touches a Deploy.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
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
import {
  logInfo,
  logWarn,
  reconcilerLoopDuration,
} from '../telemetry/index.ts';

export interface RepoLoopContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly host: RepositoryReader;
  /** Injected for tests of the push-lag wait; unset is a real timer. */
  readonly sleep?: (ms: number) => Promise<void>;
}

// A delivery can arrive before its ref is readable. One wait and one re-read;
// a second miss costs what a dropped delivery does, the next poll.
export const PUSH_LAG_RETRY_MS = 1500;

export type ScopeOutcome =
  | {
      readonly scope: string;
      readonly appId: string;
      readonly outcome: 'adopted';
      readonly proposal: DetectionProposal;
      /** Whether the file differs from the previously adopted commit's. */
      readonly changed: boolean;
    }
  | {
      readonly scope: string;
      readonly appId: string;
      /** No `SPINDRIFT_FILE` at this scope; detection still applies. */
      readonly outcome: 'absent';
    }
  | {
      readonly scope: string;
      readonly appId: string;
      readonly outcome: 'invalid';
      readonly detail: string;
    };

export type RepositoryReconciliation =
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /** The branch has not moved, or another pass adopted the commit first. */
      readonly outcome: 'unchanged';
      readonly commit: string;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /** The branch moved and this pass did not claim it (`adopt: false`). */
      readonly outcome: 'behind';
      /** The observed head, which does not govern yet. */
      readonly commit: string;
      /** The commit that still governs. */
      readonly adopted: string | null;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      readonly outcome: 'adopted';
      readonly commit: string;
      readonly scopes: readonly ScopeOutcome[];
      readonly thawed?: true;
    }
  | {
      readonly repositoryId: string;
      readonly fullName: string;
      /** Reached but not adopted: a scope's file did not parse. */
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
      /** Unreachable, or refused for a reason other than access. */
      readonly outcome: 'unavailable';
      readonly detail: string;
    };

/** A `null` or `.` subpath is the repository root. */
function spindriftPath(subpath: string | null): string {
  const scope = subpath ?? '.';
  return scope === '.' ? SPINDRIFT_FILE : `${scope}/${SPINDRIFT_FILE}`;
}

/** Writes only the repository row: a freeze never reaches what is deployed. */
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

export interface ReconcileOptions {
  /**
   * `false` for a caller that will not dispatch: it reports `behind` and leaves
   * `authoritative_commit` alone, since an undispatched claim cancels that push.
   */
  readonly adopt?: boolean;
}

/** Never throws for a far-side fault, so one repository cannot stop a pass. */
export async function reconcileRepository(
  context: RepoLoopContext,
  stored: Repository,
  options: ReconcileOptions = {},
): Promise<RepositoryReconciliation> {
  const adopt = options.adopt ?? true;
  const ref = repositoryRefOf(stored);
  const now = context.clock.now();

  let fullName: string;
  let defaultBranch: string;
  let head: string;
  // Asked every pass: a config PR closed unmerged never moves the branch, so
  // nothing else here would notice it.
  let configPullRequestClosed = false;
  try {
    const facts = await context.host.repository(ref, stored.fullName);
    ({ fullName, defaultBranch } = facts);
    head = await context.host.branchHead(ref, fullName, defaultBranch);
    if (stored.configPullRequest !== null) {
      const state = await context.host.pullRequestState(
        ref,
        fullName,
        stored.configPullRequest,
      );
      configPullRequestClosed = state === 'closed';
    }
  } catch (cause) {
    if (cause instanceof GitHubAccessError && cause.code === 'ACCESS_LOST') {
      return freeze(
        context,
        stored,
        'Spindrift can no longer read this repository',
      );
    }
    return {
      repositoryId: stored.id,
      fullName: stored.fullName,
      outcome: 'unavailable',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // The host still answers the old name, but deliveries arrive under the new
  // one, so the row follows the name the host answered with.
  let repository = stored;
  if (fullName !== stored.fullName) {
    try {
      repository = await followRename(context, stored, fullName);
    } catch (cause) {
      // Another row already holds the new name (`full_name` is unique). Keep
      // working under the stored name; merging the rows is an operator's call.
      logWarn('repository renamed; not followed', {
        'spindrift.repository': stored.fullName,
        'spindrift.repository.renamed': fullName,
        'spindrift.error':
          cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  // Reaching the repository proves access came back, even when the delivery
  // saying so was missed.
  const thawed = repository.access === 'frozen';
  if (thawed) await thaw(context, repository.id);

  if (head === repository.authoritativeCommit) {
    await context.db
      .update(repositories)
      .set({
        defaultBranch,
        reconciledAt: now,
        updatedAt: now,
        ...(configPullRequestClosed ? { configPullRequest: null } : {}),
      })
      .where(eq(repositories.id, repository.id));
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unchanged',
      commit: head,
    };
  }

  if (!adopt) {
    await context.db
      .update(repositories)
      .set({
        defaultBranch,
        reconciledAt: now,
        updatedAt: now,
        ...(configPullRequestClosed ? { configPullRequest: null } : {}),
      })
      .where(eq(repositories.id, repository.id));
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'behind',
      commit: head,
      adopted: repository.authoritativeCommit,
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
      // Compared with the adopted commit's file: a force-push, revert or merge
      // moves the branch without saying what a scope's file now says.
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
    // One bad scope rejects the whole commit. The previous commit still
    // governs, and the next pass retries this one.
    await context.db
      .update(repositories)
      .set({
        defaultBranch,
        reconciledAt: now,
        updatedAt: now,
        ...(configPullRequestClosed ? { configPullRequest: null } : {}),
      })
      .where(eq(repositories.id, repository.id));
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'rejected',
      commit: head,
      scopes: outcomes,
    };
  }

  const adopted = outcomes.some((outcome) => outcome.outcome === 'adopted');
  const [claimed] = await context.db
    .update(repositories)
    .set({
      defaultBranch,
      authoritativeCommit: head,
      reconciledAt: now,
      updatedAt: now,
      // Adopting a file is how the config PR's merge shows up here.
      ...(adopted || configPullRequestClosed
        ? { configPullRequest: null }
        : {}),
    })
    // Compare-and-swap on the commit read, so the webhook and the poll loop
    // cannot both adopt it and dispatch it twice.
    .where(
      and(
        eq(repositories.id, repository.id),
        previous === null
          ? isNull(repositories.authoritativeCommit)
          : eq(repositories.authoritativeCommit, previous),
      ),
    )
    .returning({ id: repositories.id });

  if (claimed === undefined) {
    // Another pass adopted this commit first and is dispatching it.
    return {
      repositoryId: repository.id,
      fullName: repository.fullName,
      outcome: 'unchanged',
      commit: head,
    };
  }

  // The caller must dispatch this pass. A crash before it leaves the commit
  // adopted and never deployed.
  return {
    repositoryId: repository.id,
    fullName: repository.fullName,
    outcome: 'adopted',
    commit: head,
    scopes: outcomes,
    ...(thawed ? { thawed: true as const } : {}),
  };
}

/**
 * `apps.source_repo_url` is rewritten by substitution, so a URL typed some
 * other way is left alone.
 *
 * ponytail: no far-side repository id is stored, so a new repository created
 * under a vacated name is indistinguishable from the renamed one; storing
 * `repository.id` from the push payload is the upgrade.
 */
async function followRename(
  context: RepoLoopContext,
  stored: Repository,
  fullName: string,
): Promise<Repository> {
  const now = context.clock.now();
  await context.db
    .update(repositories)
    .set({ fullName, updatedAt: now })
    .where(eq(repositories.id, stored.id));
  await context.db
    .update(apps)
    .set({
      sourceRepoUrl: sql`replace(${apps.sourceRepoUrl}, ${`/${stored.fullName}`}, ${`/${fullName}`})`,
      updatedAt: now,
    })
    .where(eq(apps.repositoryId, stored.id));
  logInfo('repository renamed; following it', {
    'spindrift.repository': fullName,
    'spindrift.repository.previous': stored.fullName,
  });
  return { ...stored, fullName };
}

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
    // A collected commit or rewritten history reads as changed, never as a
    // failed pass.
    return null;
  }
}

/** Includes frozen repositories: only a read can observe recovery. */
export async function reconcileAllRepositories(
  context: RepoLoopContext,
): Promise<readonly RepositoryReconciliation[]> {
  const connected = await context.db.select().from(repositories);

  const passes: RepositoryReconciliation[] = [];
  for (const repository of connected) {
    // Sequential: the host's rate limit is shared across the fleet.
    passes.push(await reconcileRepository(context, repository));
  }
  return passes;
}

/**
 * Takes an already verified delivery. Every branch does what the periodic pass
 * would, or nothing, so a lost delivery costs only latency.
 */
export async function applyWebhookDelivery(
  context: RepoLoopContext,
  delivery: WebhookDelivery,
): Promise<readonly RepositoryReconciliation[]> {
  if (delivery.kind === 'ignored') return [];

  if (delivery.kind === 'push') {
    // Only the default branch is authoritative.
    if (delivery.ref !== `refs/heads/${delivery.defaultBranch}`) return [];
    const [repository] = await context.db
      .select()
      .from(repositories)
      .where(eq(repositories.fullName, delivery.repository));
    if (repository === undefined) return [];
    const first = await reconcileRepository(context, repository);
    if (!lagging(first, delivery.head)) return [first];

    // The API lags its own push notifications. Retry once, and return both
    // passes: the first may have adopted a commit the dispatcher must see.
    await (context.sleep ?? sleep)(PUSH_LAG_RETRY_MS);
    const [fresh] = await context.db
      .select()
      .from(repositories)
      .where(eq(repositories.id, repository.id));
    if (fresh === undefined) return [first];
    return [first, await reconcileRepository(context, fresh)];
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

  // Restored access is not taken on the delivery's word: only a pass that
  // reads the repository clears the freeze.
  const passes: RepositoryReconciliation[] = [];
  for (const repository of affected) {
    passes.push(await reconcileRepository(context, repository));
  }
  return passes;
}

// Only a pass that read a head can lag. A `rejected` commit failed to parse,
// which is not lag.
function lagging(pass: RepositoryReconciliation, head: string): boolean {
  return (
    (pass.outcome === 'unchanged' ||
      pass.outcome === 'adopted' ||
      pass.outcome === 'behind') &&
    pass.commit !== head
  );
}

/** Empty `names` means every repository in the installation. */
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

export interface RepoLoopOptions {
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  /** Awaited before sleeping, so shutdown never races the dispatch write. */
  readonly onPass?: (
    passes: readonly RepositoryReconciliation[],
  ) => void | Promise<void>;
}

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
