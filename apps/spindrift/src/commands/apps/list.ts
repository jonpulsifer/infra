import { z } from 'zod';
import { artifactSummary } from '../../domain/artifact-name.ts';
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
              build: true,
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
      // `deploy.build` is a real Build row whenever `deploy` is — `deploys`
      // makes `build_id` `.notNull()` — never the config hash `configVersion`
      // carries: that field is §10's total hash over a document that is
      // legitimately empty for most Apps, which reads as an artifact digest
      // while answering nothing about which artifact is live.
      artifact: artifactSummary(deploy?.build),
    } satisfies AppListItem;
  });

  return ok({ apps: items });
};
