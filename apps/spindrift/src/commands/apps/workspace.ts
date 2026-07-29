import { z } from 'zod';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  DeployPhase,
  LogLine,
  Runtime,
  WorkspaceView,
} from '../../web/model.ts';
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

  const components: ComponentView[] = app.components.map((comp) => {
    const deploy = comp.deploys[0];
    const build = deploy?.build ?? comp.builds[0];
    let artifact = 'none';
    if (build?.artifactDigest) {
      artifact = `image · ${build.artifactDigest.slice(0, 12)}`;
    } else if (build?.commit) {
      artifact = `commit · ${build.commit.slice(0, 7)}`;
    }

    return {
      name: comp.name,
      kind: comp.kind,
      phase: (deploy?.phase ?? 'PENDING') as DeployPhase,
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

  const events = await context.db.query.attemptEvents.findMany({
    where: (ev, { eq }) => eq(ev.appId, app.id),
    orderBy: (ev, { desc }) => [desc(ev.id)],
    limit: 20,
  });

  const activity: ActivityEntry[] = [];
  if (events.length > 0) {
    for (const ev of events) {
      const title = ev.phase
        ? `${ev.attemptKind} ${ev.phase.toLowerCase()}`
        : ev.resource
          ? ev.resource
          : `${ev.attemptKind} event`;
      const detail = ev.resource
        ? `${ev.resource}${ev.line ? `: ${ev.line}` : ''}`
        : (ev.line ?? ev.reason ?? '');
      activity.push({
        title,
        detail,
        when: 'recently',
        status: ev.reason ? 'failed' : ev.phase === 'LIVE' ? 'ok' : 'info',
      });
    }
  } else if (latestDeploy) {
    activity.push({
      title: `Deploy ${latestDeploy.id} ${latestDeploy.phase.toLowerCase()}`,
      detail: latestDeploy.detail ?? `Target: ${latestTarget?.name ?? 'none'}`,
      when: 'recently',
      status:
        latestDeploy.phase === 'LIVE'
          ? 'ok'
          : latestDeploy.phase === 'FAILED'
            ? 'failed'
            : 'info',
    });
  }

  let runtime: Runtime;
  if (primaryComponent?.kind === 'website') {
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
  } else {
    const logEvents = events.filter((e) => e.eventType === 'log' && e.line);
    const lines: LogLine[] = logEvents.map((e) => ({
      text: e.line!,
      tone: e.reason ? ('error' as const) : undefined,
    }));
    runtime = {
      kind: 'stream',
      lines,
      reach: '7 days',
    };
  }

  const workspace: WorkspaceView = {
    app: app.name,
    target: latestTarget?.name ?? 'none',
    vessel: app.vesselRef ?? 'none',
    prerequisitesMet: latestTarget ? latestTarget.health === 'healthy' : false,
    phase: (latestDeploy?.phase ?? 'PENDING') as DeployPhase,
    url: latestDeploy?.url ?? app.vanityDomain ?? '',
    urlLive: latestDeploy?.phase === 'LIVE',
    release: latestDeploy ? `Deploy ${latestDeploy.id}` : 'latest',
    components,
    datastores: Array.from(datastoresMap.values()),
    activity,
    runtime,
  };

  return ok({ workspace });
};
