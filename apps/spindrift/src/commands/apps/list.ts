import { z } from 'zod';
import type { AppListItem, DeployPhase } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listAppsInput = z.object({});
export type ListAppsInput = z.infer<typeof listAppsInput>;

export const listApps: Command<
  ListAppsInput,
  { apps: readonly AppListItem[] }
> = async (_input, context) => {
  const allApps = await context.db.query.apps.findMany({
    orderBy: (apps, { desc }) => [desc(apps.createdAt)],
    with: {
      repository: true,
      components: {
        with: {
          deploys: {
            orderBy: (deploys, { desc }) => [desc(deploys.createdAt)],
            limit: 1,
            with: {
              target: true,
            },
          },
        },
      },
    },
  });

  const items = allApps.map((app) => {
    let source = 'archive';
    if (app.sourceKind === 'repo') {
      if (app.repository) {
        source = app.repository.fullName;
        if (app.sourceRepoSubpath) {
          source += `/${app.sourceRepoSubpath}`;
        }
      } else if (app.sourceRepoUrl) {
        try {
          const url = new URL(app.sourceRepoUrl);
          source = url.pathname.slice(1).replace(/\.git$/, '');
        } catch {
          source = app.sourceRepoUrl;
        }
      }
    }

    const comp = app.components[0];
    const deploy = comp?.deploys[0];
    const target = deploy?.target;

    return {
      id: app.id,
      name: app.name,
      vessel: app.vesselRef ?? '',
      source,
      kind: comp?.kind ?? 'service',
      phase: (deploy?.phase ?? 'PENDING') as DeployPhase,
      target: target?.name ?? 'none',
      url: deploy?.url ?? app.vanityDomain ?? '',
      urlLive: deploy?.phase === 'LIVE',
      release: deploy?.configVersion ?? 'latest',
    } satisfies AppListItem;
  });

  return ok({ apps: items });
};
