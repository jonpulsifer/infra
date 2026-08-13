import { z } from 'zod';
import {
  cloneUrlFor,
  RepositoryAuthorizationRequiredError,
} from '../../domain/repository.ts';
import { reconcileRepository } from '../../reconciler/repo-loop.ts';
import { type Command, ok } from '../types.ts';
import type {
  GrantedRepositoryView,
  LinkedRepoView,
  RepositoryConnectorView,
  RepositoryOptionView,
} from '../views.ts';

export const listRepositoriesInput = z.object({});
export type ListRepositoriesInput = z.infer<typeof listRepositoriesInput>;

export interface ListRepositoriesResult {
  readonly repos: readonly LinkedRepoView[];
  /** Durable connections consumed by the App creation flow. */
  readonly options: readonly RepositoryOptionView[];
  /** Repositories GitHub currently grants, consumed by the connector form. */
  readonly available: readonly GrantedRepositoryView[];
  readonly connector: RepositoryConnectorView;
}

export const listRepositories: Command<
  ListRepositoriesInput,
  ListRepositoriesResult
> = async (_input, context) => {
  const host = context.adapters.repository?.() ?? null;
  // Refreshed together rather than one after another. This read is on the
  // creation screen's critical path and every active repository was a serial
  // round trip to the host, so the screen waited for the sum of them — and a
  // slow one made the wizard look broken rather than busy.
  const staleReasons = new Map<string, string>();
  if (host !== null) {
    const existing = await context.db.query.repositories.findMany();
    await Promise.all(
      existing
        .filter((repo) => repo.access === 'active')
        .map(async (repo) => {
          // One repository the host would not answer about does not empty the
          // list — but the row it happened to says so, because the alternative
          // is a commit from an hour ago rendered as current. `unavailable` is
          // the loop's own word for that, and a throw is the same fact
          // arriving as an exception.
          try {
            const pass = await reconcileRepository(
              { db: context.db, clock: context.clock, host },
              repo,
            );
            if (pass.outcome === 'unavailable') {
              staleReasons.set(repo.id, pass.detail);
            }
          } catch (cause) {
            staleReasons.set(
              repo.id,
              cause instanceof Error ? cause.message : String(cause),
            );
          }
        }),
    );
  }

  const allRepos = await context.db.query.repositories.findMany({
    orderBy: (repositories, { asc }) => [asc(repositories.fullName)],
  });

  const allApps = await context.db.query.apps.findMany({
    with: {
      repository: true,
    },
  });

  const subpathsByRepoId = new Map<string, Set<string>>();

  for (const app of allApps) {
    let repoId = app.repositoryId;
    if (!repoId && app.sourceRepoUrl) {
      try {
        const path = new URL(app.sourceRepoUrl).pathname
          .slice(1)
          .replace(/\.git$/, '');
        const matched = allRepos.find((r) => r.fullName === path);
        if (matched) repoId = matched.id;
      } catch {
        // ignore invalid URL
      }
    }
    if (repoId) {
      if (!subpathsByRepoId.has(repoId)) {
        subpathsByRepoId.set(repoId, new Set());
      }
      subpathsByRepoId.get(repoId)!.add(app.sourceRepoSubpath || '.');
    }
  }

  const reposList: LinkedRepoView[] = [];

  for (const repo of allRepos) {
    const subpathsSet = subpathsByRepoId.get(repo.id);
    const appSubpaths = subpathsSet ? Array.from(subpathsSet).sort() : [];
    const isConnected = repo.access === 'active';

    reposList.push({
      repositoryId: repo.id,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      health: isConnected ? 'connected' : 'connection_lost',
      error: repo.frozenReason ?? null,
      lastReconciledSha: repo.authoritativeCommit ?? null,
      staleReason: staleReasons.get(repo.id) ?? null,
      appSubpaths,
      configPullRequest: repo.configPullRequest ?? null,
    });
  }

  const authorization = context.adapters.repositoryAuthorization?.() ?? null;
  const webBaseUrl = context.manifest.github.webBaseUrl;
  let connector: RepositoryConnectorView = { state: 'unavailable' };
  let available: readonly {
    readonly repositoryId: string;
    readonly fullName: string;
    readonly defaultBranch: string;
  }[] = allRepos.map((repo) => ({
    repositoryId: repo.id,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
  }));
  if (authorization !== null) {
    const status = await authorization.status();
    if (status.state === 'authorized') {
      connector = {
        ...status,
        installUrl: `${webBaseUrl}/apps/${status.slug}/installations/new`,
      };
      try {
        available = await authorization.repositories();
      } catch (cause) {
        // The identity vanished between the status read and the enumeration —
        // the row was discarded mid-request. Rendered as the create-one state,
        // which is what the next load would say anyway.
        if (cause instanceof RepositoryAuthorizationRequiredError) {
          connector = {
            state: 'unauthorized',
            setup: await authorization.setup(context.principal.id),
          };
          available = allRepos.map((repo) => ({
            repositoryId: repo.id,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
          }));
        } else {
          throw cause;
        }
      }
    } else {
      connector = {
        state: 'unauthorized',
        setup: await authorization.setup(context.principal.id),
      };
    }
  }
  const connectedByName = new Map(
    reposList.map((repo) => [repo.fullName, repo] as const),
  );
  const availableList: GrantedRepositoryView[] = available.map((repo) => ({
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    cloneUrl: cloneUrlFor(webBaseUrl, repo.fullName),
    rowExists: connectedByName.has(repo.fullName),
  }));
  const optionsList: RepositoryOptionView[] = allRepos.map((repo) => ({
    repositoryId: repo.id,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    cloneUrl: cloneUrlFor(webBaseUrl, repo.fullName),
    alreadyDeploys: subpathsByRepoId.has(repo.id),
  }));

  return ok({
    repos: reposList,
    options: optionsList,
    available: availableList,
    connector,
  });
};
