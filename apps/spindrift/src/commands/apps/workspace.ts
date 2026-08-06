import { z } from 'zod';
import type { JobRuns } from '../../adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { artifactSummary } from '../../domain/artifact-name.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  type TargetConnection,
} from '../../domain/target.ts';
import type { VesselLocation } from '../../domain/vessel.ts';
import type {
  ActivityEntry,
  ComponentView,
  DatastoreView,
  DeployPhase,
  Runtime,
  WorkspaceView,
} from '../../web/model.ts';
import { configuredKeys } from '../config/set.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

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
              // The boundary as well as the surface: a job's runs are read
              // from the platform, and `deployTargetOf` needs both rows.
              target: { with: { vessel: true } },
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
              // With its vessel, for the reason the deploy's Target carries
              // one: `workspaceTarget` is either of these two rows and the
              // screen states the boundary from whichever it got.
              target: { with: { vessel: true } },
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

    return {
      id: comp.id,
      name: comp.name,
      kind: comp.kind,
      phase: phaseFor(deploy?.phase, build?.status),
      artifact: artifactSummary(build),
      reach: comp.reach,
      auth: comp.auth,
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

  // Keys only, never values (§10) — `configuredKeys` is the same read
  // `setConfig` itself uses to know what is already there, and it is the
  // only shape a screen is allowed to show: core's store has no verb that
  // returns a value. Scoped to the same pair the rest of this screen already
  // picked — `workspaceTarget`, not every Target the Component might be
  // placed on — because that pair is what a `Set variable` here would act on.
  const configKeys =
    primaryComponent && workspaceTarget
      ? await configuredKeys(
          context.db,
          primaryComponent.id,
          workspaceTarget.id,
        )
      : [];

  // Status events only — the checkpoints, not the transcript.
  //
  // Every log line an adapter emits lands in `attempt_events` too, and reading
  // the table raw made the timeline the last twenty lines of whatever ran most
  // recently: three screens of BuildKit chatter where a reader wanted "built,
  // deployed, went red". A checkpoint is a status event by definition — §6's
  // `{phase, resource?, reason?}` — so the filter is the whole selection, and
  // the text stays where it belongs, on the attempt screen each entry links to.
  // Ten, and this is the only bound: the workspace renders what it is given, so
  // a second limit in the view could only disagree with this one. Three showed
  // one attempt's worth of checkpoints, and the shape the timeline exists to
  // make legible — built, deployed, went red — is three attempts, not three
  // events.
  const events = await context.db.query.attemptEvents.findMany({
    where: (ev, { eq, and }) =>
      and(eq(ev.appId, app.id), eq(ev.eventType, 'status')),
    orderBy: (ev, { desc }) => [desc(ev.id)],
    limit: 10,
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
    runtime = await executionsOf(
      context,
      primaryComponent.id,
      latestDeploy ?? null,
      now,
    );
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
    vessel: workspaceTarget?.vessel.name ?? 'none',
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
    configKeys,
    datastores: Array.from(datastoresMap.values()),
    activity,
    runtime,
    autoDeploy: app.sourceKind === 'repo' ? app.autoDeploy : null,
  };

  return ok({ workspace });
};

/**
 * How many runs the screen asks for (§17).
 *
 * §17 fixes N at 10 and the App chart renders exactly that —
 * `successfulJobsHistoryLimit` and `failedJobsHistoryLimit` in
 * `packages/charts/spindrift-app/templates/cronjob.yaml`.
 *
 * ponytail: it is a page size on every backend and a retention depth on only
 * one. On `kubernetes` it happens to be both, because the chart Spindrift
 * renders sets the same number; Cloud Run keeps its own count of executions and
 * reports it nowhere, so a job there may well have runs beyond this. The
 * caption beneath the list says only what this is — how many are shown — for
 * that reason. Upgrade path: return the depth from `executions` and let each
 * adapter answer with what it observes.
 */
const RETAINED_RUNS = 10;

/** What {@link executionsOf} reads off the Deploy that placed the job. */
interface PlacedJob {
  /** §6's opaque handle. Null until an `apply` placed something. */
  readonly ref: string | null;
  readonly target: {
    readonly id: string;
    readonly name: string;
    readonly adapter: TargetAdapter;
    readonly connection: TargetConnection | null;
    readonly vessel: {
      readonly location: VesselLocation | null;
      readonly servedHosts: readonly string[] | null;
      readonly reachableRegistries: readonly string[] | null;
    } | null;
  } | null;
}

/**
 * The runs a job has had, read from the platform (§17).
 *
 * §17 keeps a job's history on the backend — "configure the platform, don't
 * build it" — so this is a live read on every load of the screen rather than a
 * table Spindrift maintains. A stored history would have to be reconciled
 * against the CronJob that prunes it, and would be wrong for every run the
 * scheduler started rather than an operator.
 *
 * **Every failure is an empty state, never a failed screen.** A Target that
 * will not answer is one card's worth of bad news; the App's phase, its URL and
 * its timeline are all still readable, and taking the workspace down over a
 * cluster that is momentarily unreachable would hide the very things an
 * operator opened it to see.
 *
 * **A failed read is still a runnable job.** Whether this job can be run is a
 * fact about the Deploy that placed it, not about whether listing its runs
 * worked, so a Target that refuses the list answers on the `executions` arm
 * with the reason on it rather than on `none`. The two are one screen apart:
 * `none` renders no Run now button, and the first thing an operator meets after
 * this merges is a cluster whose Role has not reconciled yet, answering `403`
 * to the list. Hiding the control there hides it exactly where its refusal is
 * the diagnosis.
 */
async function executionsOf(
  context: CommandContext,
  componentId: string,
  placed: PlacedJob | null,
  now: Date,
): Promise<Runtime> {
  const surface = placed?.target ?? null;
  const vessel = surface?.vessel ?? null;
  if (placed?.ref == null || surface === null || vessel === null) {
    return {
      kind: 'none',
      because: 'This job has not been placed on a Target yet.',
    };
  }
  if (!hasTargetConnection(surface) || !hasVesselLocation(vessel)) {
    return {
      kind: 'none',
      because: `${surface.name} is not connected, so its runs cannot be read.`,
    };
  }
  const adapter = context.adapters.deploy(surface.adapter);
  if (adapter === null) {
    return {
      kind: 'none',
      because: `This installation has no ${surface.adapter} adapter.`,
    };
  }

  const runnable = {
    kind: 'executions',
    componentId,
    targetId: surface.id,
    retained: RETAINED_RUNS,
  } as const;

  let runs: JobRuns;
  try {
    runs = await adapter.executions(
      deployTargetOf(surface, vessel),
      placed.ref,
      RETAINED_RUNS,
    );
  } catch (cause) {
    return {
      ...runnable,
      executions: [],
      because: `The runs on ${surface.name} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  // A refusal is the adapter saying this ref names no job it can report on —
  // a Service's handle, a release that is gone. There is nothing to run either,
  // so this one does collapse to `none`.
  if (runs.kind === 'none') return { kind: 'none', because: runs.because };

  return {
    ...runnable,
    executions: runs.executions.map((execution) => ({
      name: execution.name,
      outcome: execution.outcome,
      detail: execution.detail ?? '',
      // A run the backend has accepted and not started carries no time, and
      // "just now" is what that is — the same word `elapsedSince` uses for the
      // first minute, so the column reads consistently either way.
      when:
        execution.startedAt === null
          ? 'just now'
          : elapsedSince(execution.startedAt, now),
    })),
  };
}

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
