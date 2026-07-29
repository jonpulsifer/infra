import { z } from 'zod';
import type { LinkedRepoView, RepositoryOptionView } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listRepositoriesInput = z.object({});
export type ListRepositoriesInput = z.infer<typeof listRepositoriesInput>;

export interface ListRepositoriesResult {
  readonly repos: readonly LinkedRepoView[];
  readonly options: readonly RepositoryOptionView[];
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
  const optionsList: RepositoryOptionView[] = [];

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

    optionsList.push({
      repositoryId: repo.id,
      fullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      connected: appSubpaths.length > 0,
    });
  }

  return ok({
    repos: reposList,
    options: optionsList,
  });
};
