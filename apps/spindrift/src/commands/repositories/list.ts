import { z } from 'zod';
import { RepositoryAuthorizationRequiredError } from '../../domain/repository.ts';
import type {
  LinkedRepoView,
  RepositoryConnectorView,
  RepositoryOptionView,
} from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listRepositoriesInput = z.object({});
export type ListRepositoriesInput = z.infer<typeof listRepositoriesInput>;

export interface ListRepositoriesResult {
  readonly repos: readonly LinkedRepoView[];
  /** Durable connections consumed by the App creation flow. */
  readonly options: readonly RepositoryOptionView[];
  /** Repositories GitHub currently grants, consumed by the connector form. */
  readonly available: readonly RepositoryOptionView[];
  readonly connector: RepositoryConnectorView;
}

export const listRepositories: Command<
  ListRepositoriesInput,
  ListRepositoriesResult
> = async (_input, context) => {
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
      appSubpaths,
    });
  }

  const authorization = context.adapters.repositoryAuthorization?.() ?? null;
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
    connector = status;
    if (status.state === 'authorized') {
      try {
        available = await authorization.repositories();
      } catch (cause) {
        if (cause instanceof RepositoryAuthorizationRequiredError) {
          connector = { state: 'unauthorized' };
          available = allRepos.map((repo) => ({
            repositoryId: repo.id,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
          }));
        } else {
          throw cause;
        }
      }
    }
  }
  const connectedByName = new Map(
    reposList.map((repo) => [repo.fullName, repo] as const),
  );
  const availableList: RepositoryOptionView[] = available.map((repo) => ({
    repositoryId: repo.repositoryId,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    connected: connectedByName.has(repo.fullName),
  }));
  const optionsList: RepositoryOptionView[] = allRepos.map((repo) => ({
    repositoryId: repo.id,
    fullName: repo.fullName,
    defaultBranch: repo.defaultBranch,
    connected: subpathsByRepoId.has(repo.id),
  }));

  return ok({
    repos: reposList,
    options: optionsList,
    available: availableList,
    connector,
  });
};
