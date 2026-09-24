import { z } from 'zod';
import { artifactSummary } from '../../domain/artifact-name.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { type Command, ok } from '../types.ts';
import type { AppListItem, DeployPhase } from '../views.ts';

/**
 * Phase severity, worst first. A row shows its worst Component's phase, and
 * in-flight phases rank the least progressed first.
 */
const SEVERITY = {
  FAILED: 0,
  PENDING: 1,
  APPLYING: 2,
  WAITING: 3,
  LIVE: 4,
} as const satisfies Record<DeployPhase, number>;

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
              // The vessel comes from the placed Target; the App has none.
              target: { with: { vessel: true } },
              build: true,
            },
          },
          // Tells a placed but never-deployed Component from an unplaced one.
          placedTarget: { with: { vessel: true } },
        },
      },
    },
  });

  const now = context.clock.now();

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

    // Every fact on the row comes from the worst Component. A faulty release
    // ranks as FAILED although its phase stays `LIVE`.
    const ranked = app.components.map((component) => ({
      component,
      deploy: component.deploys[0],
      phase: (component.deploys[0]?.phase ?? 'PENDING') as DeployPhase,
      faulty: component.deploys[0]?.faultyAt != null,
    }));
    const severity = (row: (typeof ranked)[number]) =>
      row.faulty ? SEVERITY.FAILED : SEVERITY[row.phase];
    const worst = ranked.reduce<(typeof ranked)[number] | undefined>(
      (chosen, candidate) =>
        chosen === undefined || severity(candidate) < severity(chosen)
          ? candidate
          : chosen,
      undefined,
    );

    const comp = worst?.component;
    const deploy = worst?.deploy;
    const target = deploy?.target;
    const placed = deploy === undefined ? comp?.placedTarget : undefined;

    return {
      id: app.id,
      name: app.name,
      vessel: target?.vessel.name ?? placed?.vessel.name ?? '',
      source,
      kind: comp?.kind ?? 'service',
      phase: worst?.phase ?? 'PENDING',
      target:
        target?.adapter ??
        (placed == null ? 'none' : `${placed.adapter} (awaiting first deploy)`),
      // Never `vanityDomain`, which holds a label such as `@` instead of a host.
      url: deploy?.url ?? '',
      urlLive: deploy?.phase === 'LIVE' && !worst?.faulty,
      faulty: worst?.faulty ?? false,
      componentCount: app.components.length,
      failing: ranked.filter((row) => row.phase === 'FAILED' || row.faulty)
        .length,
      // Only where a release exists, so an undeployed App is not dated by this
      // query.
      ...(deploy === undefined
        ? {}
        : {
            commit: deploy.build.commit,
            commitMessage: deploy.build.commitMessage,
            when: elapsedSince(deploy.createdAt, now),
            at: deploy.createdAt.toISOString(),
            deployId: deploy.id,
          }),
      // From the Build; `configVersion` is a config hash that only looks like
      // an artifact digest.
      artifact: artifactSummary(deploy?.build),
    } satisfies AppListItem;
  });

  return ok({ apps: items });
};
