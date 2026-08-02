import { z } from 'zod';
import { elapsedSince } from '../../domain/elapsed.ts';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  DeployPhase,
  Runtime,
  WorkspaceView,
} from '../../web/model.ts';
import { releasesOf } from '../deploys/list.ts';
import { type Command, failed, ok } from '../types.ts';

export const getAppWorkspaceInput = z.object({
  name: z.string().min(1),
});
export type GetAppWorkspaceInput = z.infer<typeof getAppWorkspaceInput>;

export const getAppWorkspace: Command<
  GetAppWorkspaceInput,
  { workspace: WorkspaceView }
> = async (input, context) => {
  const isUuid = z.string().uuid().safeParse(input.name).success;
  const app = await context.db.query.apps.findFirst({
    where: (apps, { eq, or }) =>
      isUuid
        ? or(eq(apps.name, input.name), eq(apps.id, input.name))
        : eq(apps.name, input.name),
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
          builds: {
            orderBy: (builds, { desc }) => [desc(builds.createdAt)],
            limit: 1,
          },
          desiredTargets: {
            limit: 1,
            with: {
              target: true,
            },
          },
        },
      },
      datastores: {
        with: {
          target: true,
        },
      },
    },
  });

  if (!app) {
    return failed('NOT_FOUND', `App '${input.name}' not found`);
  }

  const unattachedDatastores = await context.db.query.datastores.findMany({
    where: (ds, { isNull }) => isNull(ds.appId),
    with: {
      target: true,
    },
  });

  const primaryComponent = app.components[0];
  const latestDeploy = primaryComponent?.deploys[0];
  const latestTarget = latestDeploy?.target;
  const desiredTarget = primaryComponent?.desiredTargets[0]?.target;
  const workspaceTarget = latestTarget ?? desiredTarget;

  const components: ComponentView[] = app.components.map((comp) => {
    const deploy = comp.deploys[0];
    const build = deploy?.build ?? comp.builds[0];
    let artifact = 'none';
    if (build?.artifactDigest) {
      artifact = `${build.artifactType} · ${build.artifactDigest.slice(0, 12)}`;
    } else if (build?.commit) {
      artifact = `${build.artifactType} from ${build.commit.slice(0, 7)}`;
    }

    return {
      name: comp.name,
      kind: comp.kind,
      phase: phaseFor(deploy?.phase, build?.status),
      artifact,
      exposure: comp.exposure,
    };
  });

  const datastoresMap = new Map<string, DatastoreView>();

  for (const ds of app.datastores) {
    datastoresMap.set(ds.name, {
      name: ds.name,
      engine: ds.engine,
      provenance: ds.provenance,
      attachedTo: primaryComponent?.name ?? app.name,
      target: ds.target?.name ?? 'none',
    });
  }

  for (const ds of unattachedDatastores) {
    if (!datastoresMap.has(ds.name)) {
      datastoresMap.set(ds.name, {
        name: ds.name,
        engine: ds.engine,
        provenance: ds.provenance,
        attachedTo: null,
        target: ds.target?.name ?? 'none',
      });
    }
  }

  // Status events only — the checkpoints, not the transcript.
  //
  // Every log line an adapter emits lands in `attempt_events` too, and reading
  // the table raw made the timeline the last twenty lines of whatever ran most
  // recently: three screens of BuildKit chatter where a reader wanted "built,
  // deployed, went red". A checkpoint is a status event by definition — §6's
  // `{phase, resource?, reason?}` — so the filter is the whole selection, and
  // the text stays where it belongs, on the attempt screen each entry links to.
  const events = await context.db.query.attemptEvents.findMany({
    where: (ev, { eq, and }) =>
      and(eq(ev.appId, app.id), eq(ev.eventType, 'status')),
    orderBy: (ev, { desc }) => [desc(ev.id)],
    limit: 12,
  });

  const now = context.clock.now();

  // Every event belongs to exactly one attempt — the `attempt_events` check
  // constraint is what guarantees it — so every entry carries the id of the
  // screen it came from and the timeline becomes a way into the system rather
  // than a wall of past tense.
  const activity: ActivityEntry[] = [];
  if (events.length > 0) {
    for (const ev of events) {
      activity.push({
        kind: ev.attemptKind,
        title: checkpointTitle(
          ev.attemptKind,
          ev.phase,
          ev.deployId,
          ev.buildId,
        ),
        detail: ev.resource ?? ev.reason ?? '',
        when: elapsedSince(ev.createdAt, now),
        status: ev.reason ? 'failed' : ev.phase === 'LIVE' ? 'ok' : 'info',
        deployId: ev.deployId,
        buildId: ev.buildId,
      });
    }
  } else if (latestDeploy) {
    activity.push({
      kind: 'deploy',
      title: `Deploy ${latestDeploy.id} ${latestDeploy.phase.toLowerCase()}`,
      detail: latestDeploy.detail ?? `Target: ${latestTarget?.name ?? 'none'}`,
      when: elapsedSince(latestDeploy.createdAt, now),
      status:
        latestDeploy.phase === 'LIVE'
          ? 'ok'
          : latestDeploy.phase === 'FAILED'
            ? 'failed'
            : 'info',
      deployId: latestDeploy.id,
      buildId: latestDeploy.buildId,
    });
  }

  const releases = await releasesOf(
    context,
    app.components.map((component) => component.id),
  );

  let runtime: Runtime;
  if (
    primaryComponent?.kind === 'website' &&
    latestTarget?.adapter === 'static'
  ) {
    runtime = {
      kind: 'none',
      because: 'Static files are served by the Target.',
    };
  } else if (primaryComponent?.kind === 'job') {
    runtime = {
      kind: 'executions',
      executions: [],
      retained: 10,
    };
  } else if (primaryComponent && latestTarget) {
    runtime = {
      kind: 'stream',
      componentId: primaryComponent.id,
      targetId: latestTarget.id,
      lines: [],
      reach: reachOf(latestTarget.discovery?.logHistorySeconds ?? 0),
    };
  } else {
    runtime = {
      kind: 'none',
      because: 'No runtime has been deployed yet.',
    };
  }

  const workspace: WorkspaceView = {
    app: app.name,
    appId: app.id,
    componentId: primaryComponent?.id,
    targetId: workspaceTarget?.id,
    latestDeployId: latestDeploy?.id,
    latestBuildId: primaryComponent?.builds[0]?.id,
    target: workspaceTarget?.name ?? 'none',
    vessel: app.vesselRef ?? 'none',
    prerequisitesMet: workspaceTarget
      ? workspaceTarget.health === 'healthy'
      : false,
    phase: phaseFor(latestDeploy?.phase, primaryComponent?.builds[0]?.status),
    url: latestDeploy?.url ?? app.vanityDomain ?? '',
    urlLive: latestDeploy?.phase === 'LIVE',
    release: latestDeploy
      ? `Deploy ${latestDeploy.id}`
      : primaryComponent?.builds[0]
        ? `Build ${primaryComponent.builds[0].id}`
        : 'none',
    components,
    datastores: Array.from(datastoresMap.values()),
    activity,
    deploys: releases,
    runtime,
  };

  return ok({ workspace });
};

/**
 * What a checkpoint is called on the timeline.
 *
 * Named by its attempt — "Build 41", "Deploy 42" — because the two stages are
 * separate and a reader scanning the column has to be able to tell which one a
 * line is about. `${kind} ${phase}` alone could not: "failed" appeared on both
 * legs and read as one pipeline that fell over somewhere.
 *
 * A build's step transitions come through here as their own phases (`RUNNING`,
 * `SUCCEEDED`), which is why the word is lowercased rather than mapped — the
 * vocabularies differ per §6 and inventing a shared one would mean guessing at
 * a step name the runner already chose.
 */
function checkpointTitle(
  kind: 'build' | 'deploy',
  phase: string | null,
  deployId: number | null,
  buildId: number | null,
): string {
  const id = kind === 'deploy' ? deployId : buildId;
  const noun = kind === 'deploy' ? 'Deploy' : 'Build';
  const subject = id === null ? noun : `${noun} ${id}`;
  return phase ? `${subject} ${phase.toLowerCase()}` : subject;
}

function phaseFor(
  deploy: DeployPhase | undefined,
  build: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | undefined,
): DeployPhase {
  if (deploy !== undefined) return deploy;
  switch (build) {
    case 'RUNNING':
      return 'APPLYING';
    case 'SUCCEEDED':
      return 'WAITING';
    case 'FAILED':
      return 'FAILED';
    default:
      return 'PENDING';
  }
}

function reachOf(seconds: number): string {
  if (seconds <= 0) return 'live only';
  if (seconds % 86_400 === 0) {
    const days = seconds / 86_400;
    return `${days} day${days === 1 ? '' : 's'}`;
  }
  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  return `${seconds} seconds`;
}
