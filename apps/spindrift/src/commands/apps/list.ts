import { z } from 'zod';
import { artifactSummary } from '../../domain/artifact-name.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import type { AppListItem, DeployPhase } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

/**
 * How bad each phase is, worst first.
 *
 * An App has as many phases as it has Components and this list has one word for
 * it, so the word has to be the worst of them. Reading it off whichever
 * Component came back first made the row's answer depend on row order: an App
 * with a serving `web` and a red `worker` reported `live`, which is the one
 * state a triage scan exists to not miss.
 *
 * Red beats anything still moving and anything still moving beats live, because
 * both of those are states somebody has something to do about. Within the three
 * in-flight phases the least-progressed wins — §6 orders them
 * `PENDING → APPLYING → WAITING`, so the App is only as far along as its
 * furthest-behind Component.
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
              // The boundary as well as the surface: the list states which
              // vessel an App is in, and that is the placed Target's, never a
              // column on the App.
              target: { with: { vessel: true } },
              build: true,
            },
          },
          // The placement of record, for a Component that holds one and has
          // never deployed — without it the row read `none`, indistinguishable
          // from unplaced, and the difference decides whether an unplace is
          // needed before delete.
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

    /*
      The Component the row is about — the one whose phase became the App's.

      Every other fact on the row is read from that same one: its kind, its
      artifact, the commit it was built from, where it is placed and when it
      shipped. A row that named one Component's artifact beside another's
      placement would be two answers wearing one line, and the reader has no way
      to tell which Component either half belongs to.
    */
    const ranked = app.components.map((component) => ({
      component,
      deploy: component.deploys[0],
      phase: (component.deploys[0]?.phase ?? 'PENDING') as DeployPhase,
    }));
    const worst = ranked.reduce<(typeof ranked)[number] | undefined>(
      (chosen, candidate) =>
        chosen === undefined ||
        SEVERITY[candidate.phase] < SEVERITY[chosen.phase]
          ? candidate
          : chosen,
      undefined,
    );

    const comp = worst?.component;
    const deploy = worst?.deploy;
    const target = deploy?.target;
    // Placed but never deployed: the placement of record answers where the
    // deploy history cannot, marked so the row is distinguishable from a
    // placement something has shipped to — and from `none`, which now means
    // exactly "not placed anywhere".
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
      url: deploy?.url ?? app.vanityDomain ?? '',
      urlLive: deploy?.phase === 'LIVE',
      componentCount: app.components.length,
      failing: ranked.filter((row) => row.phase === 'FAILED').length,
      // Only where a release exists. An App nobody has deployed has no commit
      // and no date, and rendering "just now" over one that has never shipped
      // would date the App by when this query ran.
      ...(deploy === undefined
        ? {}
        : {
            commit: deploy.build.commit,
            when: elapsedSince(deploy.createdAt, now),
            at: deploy.createdAt.toISOString(),
            deployId: deploy.id,
          }),
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
