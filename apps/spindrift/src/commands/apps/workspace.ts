import { z } from 'zod';
import type {
  Blame,
  FailureReason,
  JobRuns,
} from '../../adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { artifactSummary } from '../../domain/artifact-name.ts';
import { runsNothingOn } from '../../domain/capabilities.ts';
import { elapsedSince } from '../../domain/elapsed.ts';
import { servesNetwork, vanity, zoneFor } from '../../domain/naming.ts';
import {
  datastoreVesselLabel,
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  type TargetConnection,
  targetLabel,
  targetRowLabel,
} from '../../domain/target.ts';
import type { VesselLocation } from '../../domain/vessel.ts';
import { buildRouteFor } from '../builds/route.ts';
import { configuredKeys } from '../config/set.ts';
import { principalLabels } from '../principals.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import type {
  ActivityEntry,
  AppLockView,
  BuildRouteOptionView,
  ComponentView,
  DatastoreView,
  DeployPhase,
  Diagnosis,
  DriftView,
  PrerequisiteRowView,
  Runtime,
  WorkspaceSourceView,
  WorkspaceView,
} from '../views.ts';
import { namesUnder, placementsFor } from './names.ts';

export const getAppWorkspaceInput = z.object({
  name: z.string().min(1),
  /**
   * The selected Component's name; absent selects the App's first. It narrows
   * only the per-Component half of {@link WorkspaceView}.
   */
  component: z.string().min(1).optional(),
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
        // Oldest first, so the default selection is stable across loads.
        orderBy: (comps, { asc }) => [asc(comps.createdAt)],
        with: {
          deploys: {
            orderBy: (deploys, { desc }) => [desc(deploys.createdAt)],
            limit: 1,
            with: {
              // With the vessel: `deployTargetOf` needs both to read a job's runs.
              target: { with: { vessel: true } },
              build: true,
            },
          },
          builds: {
            orderBy: (builds, { desc }) => [desc(builds.createdAt)],
            limit: 1,
          },
          placedTarget: { with: { vessel: true } },
          // Pairs still serving: `placeComponent` leaves the old pair's desired
          // row until `unplaceComponent` retires it.
          desiredTargets: { with: { target: { with: { vessel: true } } } },
        },
      },
      datastores: {
        with: {
          vessel: true,
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
      vessel: true,
    },
  });

  const selected =
    input.component === undefined
      ? app.components[0]
      : app.components.find((comp) => comp.name === input.component);

  if (input.component !== undefined && selected === undefined) {
    return failed(
      'NOT_FOUND',
      `App '${app.name}' has no Component '${input.component}'`,
    );
  }

  const latestDeploy = selected?.deploys[0];
  const latestTarget = latestDeploy?.target;
  // The placement of record, which the deploy button acts on. Deploy history
  // would name a Target the Component has moved away from.
  const workspaceTarget = selected?.placedTarget ?? undefined;

  const now = context.clock.now();

  const components: ComponentView[] = app.components.map((comp) => {
    const deploy = comp.deploys[0];
    const build = deploy?.build ?? comp.builds[0];
    const placed = deploy?.target;

    return {
      id: comp.id,
      name: comp.name,
      kind: comp.kind,
      phase: phaseFor(deploy?.phase, build?.status),
      artifact: artifactSummary(build),
      reach: comp.reach,
      auth: comp.auth,
      ...(placed === undefined ? {} : { target: targetRowLabel(placed) }),
      // Sorted by label so the order is stable across loads.
      serving: comp.desiredTargets
        .map((pair) => ({
          targetId: pair.targetId,
          label: targetRowLabel(pair.target),
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
      ...(deploy?.url == null || deploy.url === ''
        ? {}
        : { url: deploy.url, urlLive: deploy.phase === 'LIVE' }),
      ...(deploy === undefined
        ? {}
        : { when: elapsedSince(deploy.createdAt, now) }),
    };
  });

  // Keyed on id: `datastores` is unique on (vessel_id, name), so two vessels
  // can each hold a store of the same name.
  const datastoresMap = new Map<string, DatastoreView>();

  for (const ds of [...app.datastores, ...unattachedDatastores]) {
    datastoresMap.set(ds.id, {
      id: ds.id,
      name: ds.name,
      engine: ds.engine,
      provenance: ds.provenance,
      // Attached to the App, so it names the first Component whatever the
      // selection.
      attachedTo:
        ds.appId === null ? null : (app.components[0]?.name ?? app.name),
      target: datastoreVesselLabel(ds.vessel),
      phase: ds.phase,
      ...(ds.detail === null ? {} : { detail: ds.detail }),
    });
  }

  // Keys only, never values, for the selected Component on its placed Target:
  // the pair a `Set variable` here acts on.
  const configKeys =
    selected && workspaceTarget
      ? await configuredKeys(context.db, selected.id, workspaceTarget.id)
      : [];

  // Attempt-level checkpoints only. A status event with a `resource` is one
  // step inside an attempt, and would crowd real checkpoints out of the limit.
  const events = await context.db.query.attemptEvents.findMany({
    where: (ev, { eq, and, isNull }) =>
      and(
        eq(ev.appId, app.id),
        eq(ev.eventType, 'status'),
        isNull(ev.resource),
      ),
    orderBy: (ev, { desc }) => [desc(ev.id)],
    // The only bound: the view renders what it is given.
    limit: 10,
  });

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
        status: ev.reason
          ? 'failed'
          : ev.phase === 'LIVE' || ev.phase === 'SUCCEEDED'
            ? 'ok'
            : 'info',
        deployId: ev.deployId,
        buildId: ev.buildId,
      });
    }
  } else if (latestDeploy) {
    activity.push({
      kind: 'deploy',
      title: `Deploy ${latestDeploy.id} ${latestDeploy.faultyAt ? 'faulty' : latestDeploy.phase.toLowerCase()}`,
      detail: latestDeploy.detail ?? `Target: ${targetRowLabel(latestTarget)}`,
      when: elapsedSince(latestDeploy.createdAt, now),
      status: latestDeploy.faultyAt
        ? 'failed'
        : latestDeploy.phase === 'LIVE'
          ? 'ok'
          : latestDeploy.phase === 'FAILED'
            ? 'failed'
            : 'info',
      deployId: latestDeploy.id,
      buildId: latestDeploy.buildId,
    });
  } else if (selected?.builds[0]) {
    // A new App's first Build: its status events all carry a `resource`, so
    // the filter above sees none until it ends.
    const build = selected.builds[0];
    activity.push({
      kind: 'build',
      title: `Build ${build.id} ${build.status.toLowerCase()}`,
      detail: build.commit,
      when: elapsedSince(build.createdAt, now),
      status:
        build.status === 'SUCCEEDED'
          ? 'ok'
          : build.status === 'FAILED'
            ? 'failed'
            : 'info',
      deployId: null,
      buildId: build.id,
    });
  }

  // The reconciler publishes no vanity record for an App with two serving
  // Components, since it cannot tell which one the name means.
  const serving = app.components.filter(servesNetwork);
  const vanityIsPublished = serving.length === 1;
  const placements = await placementsFor(context.db, app.id);
  // `@` means the zone apex and is no address, so the label becomes a host.
  const vanityZone =
    vanityIsPublished && app.vanityDomain !== null && selected !== undefined
      ? zoneFor(selected.reach, context.manifest.dns.zones, app.zone)
      : null;
  const vanityHost =
    vanityZone === null || app.vanityDomain === null
      ? ''
      : vanity(app.vanityDomain, vanityZone);

  // A job has no address. The vanity host is a fallback for a serving
  // Component not yet deployed, and is empty while two Components serve.
  const url = latestDeploy?.url ?? (selected?.kind === 'job' ? '' : vanityHost);

  let runtime: Runtime;
  if (
    selected?.kind === 'website' &&
    latestTarget !== undefined &&
    latestTarget !== null &&
    runsNothingOn(latestTarget.adapter)
  ) {
    runtime = {
      kind: 'none',
      because: 'Static files are served by the Target.',
    };
  } else if (selected?.kind === 'job') {
    runtime = await executionsOf(
      context,
      selected.id,
      latestDeploy ?? null,
      now,
    );
  } else if (selected && latestTarget) {
    runtime = {
      kind: 'stream',
      componentId: selected.id,
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

  // A faulty release is the soak's verdict after `LIVE`. It fills the same
  // columns as a red attempt, so the same panel explains it.
  const diagnosis: Diagnosis | null =
    latestDeploy &&
    (latestDeploy.phase === 'FAILED' || latestDeploy.faultyAt !== null) &&
    latestDeploy.reason
      ? {
          reason: latestDeploy.reason as FailureReason,
          blame: (latestDeploy.blame ?? null) as Blame | null,
          detail: latestDeploy.detail ?? 'Deploy failed',
          evidence: evidenceOf(latestDeploy.debug),
        }
      : null;

  const drift: DriftView | null =
    latestDeploy?.driftedAt == null
      ? null
      : {
          since: elapsedSince(latestDeploy.driftedAt, now),
          at: latestDeploy.driftedAt.toISOString(),
          observedDigest: latestDeploy.observedDigest,
          detail: latestDeploy.driftDetail,
        };

  // Unmet rows only and without remediation, which the Targets screen composes.
  const unmetPrerequisites: readonly PrerequisiteRowView[] = (
    workspaceTarget?.prerequisites ?? []
  )
    .filter((row) => !row.met)
    .map((row) => ({
      name: row.name,
      met: false,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
    }));

  // An archive App consults no build route, so it has none to choose.
  const buildRoute = app.sourceKind === 'repo' ? app.buildRoute : null;

  // No App id: it would narrow the options to the route already chosen. An
  // option eligible here can still fail `setAppBuildRoute`'s registry check.
  const buildRouteOptions: readonly BuildRouteOptionView[] =
    app.sourceKind === 'repo' && workspaceTarget
      ? (await buildRouteFor(workspaceTarget.id, context)).candidates.map(
          (candidate) => ({
            name: candidate.route,
            adapter:
              context.manifest.build.routes.find(
                (route) => route.name === candidate.route,
              )?.adapter ?? null,
            level: candidate.level,
            eligible: candidate.eligible,
            reason: candidate.reason,
          }),
        )
      : [];

  const lock: AppLockView | null =
    app.lockReason === null || app.lockedAt === null
      ? null
      : {
          reason: app.lockReason,
          by:
            (await principalLabels(context.db, [app.lockedBy]))(app.lockedBy) ??
            'unknown',
          since: elapsedSince(app.lockedAt, now),
          at: app.lockedAt.toISOString(),
        };

  // Pushed but not live: the adopted commit against the serving Build's, rerun
  // suffix stripped. `dispatched`: the newest Build is of it and has not failed.
  const commitOf = (ref: string | undefined) => ref?.split('#')[0] ?? null;
  const servingCommit = commitOf(latestDeploy?.build.commit);
  const newestBuild = selected?.builds[0];
  const source: WorkspaceSourceView | null =
    app.repository === null
      ? null
      : {
          branch: app.repository.defaultBranch,
          url: `${context.manifest.github.webBaseUrl}/${app.repository.fullName}`,
          pending:
            app.repository.authoritativeCommit !== null &&
            servingCommit !== null &&
            app.repository.authoritativeCommit !== servingCommit
              ? {
                  commit: app.repository.authoritativeCommit,
                  dispatched:
                    newestBuild !== undefined &&
                    newestBuild.status !== 'FAILED' &&
                    commitOf(newestBuild.commit) ===
                      app.repository.authoritativeCommit,
                }
              : null,
        };

  const workspace: WorkspaceView = {
    app: app.name,
    appId: app.id,
    componentId: selected?.id,
    targetId: workspaceTarget?.id,
    vesselId: workspaceTarget?.vessel.id,
    latestDeployId: latestDeploy?.id,
    latestBuildId: selected?.builds[0]?.id,
    target: workspaceTarget?.adapter ?? 'none',
    vessel: workspaceTarget?.vessel.name ?? 'none',
    prerequisitesMet: workspaceTarget
      ? workspaceTarget.health === 'healthy'
      : false,
    phase: phaseFor(latestDeploy?.phase, selected?.builds[0]?.status),
    url,
    // A placed job is `LIVE` with no address, and a faulty release is `LIVE`
    // with nothing answering; neither is serving.
    urlLive:
      url !== '' &&
      latestDeploy?.phase === 'LIVE' &&
      latestDeploy.faultyAt === null,
    faulty: latestDeploy?.faultyAt != null,
    release: latestDeploy
      ? `Deploy ${latestDeploy.id}`
      : selected?.builds[0]
        ? `Build ${selected.builds[0].id}`
        : 'none',
    components,
    configKeys,
    datastores: Array.from(datastoresMap.values()),
    activity,
    runtime,
    autoDeploy: app.sourceKind === 'repo' ? app.autoDeploy : null,
    // The preview `setAppZone` and `setAppVanity` answer with.
    domain: {
      label: app.vanityDomain,
      zone: app.zone,
      zones: context.manifest.dns.zones.map((zone) => ({
        name: zone.name,
        reaches: zone.reaches,
      })),
      hostnames: placements.flatMap((placement) =>
        namesUnder(
          app.name,
          placement,
          context.manifest.dns.zones,
          app.zone,
          vanityIsPublished ? app.vanityDomain : null,
        ),
      ),
      ambiguous: serving.length > 1,
      servedBy: vanityIsPublished ? (serving[0]?.name ?? null) : null,
    },
    // A null `buildRoute` cannot tell an archive App from a repo App with no
    // route, so this is stated.
    archiveSourced: app.sourceKind !== 'repo',
    buildRoute,
    buildRouteOptions,
    ...(latestDeploy === undefined
      ? {}
      : {
          commit: latestDeploy.build.commit,
          commitMessage: latestDeploy.build.commitMessage,
          when: elapsedSince(latestDeploy.createdAt, now),
          at: latestDeploy.createdAt.toISOString(),
        }),
    ...(diagnosis === null ? {} : { diagnosis }),
    ...(drift === null ? {} : { drift }),
    ...(unmetPrerequisites.length === 0 ? {} : { unmetPrerequisites }),
    ...(lock === null ? {} : { lock }),
    ...(source === null ? {} : { source }),
  };

  return ok({ workspace });
};

/**
 * The Deploy's raw `debug` payload as text, or `null` when there is none. An
 * empty `{}` or `[]` counts as none, so the panel omits its disclosure.
 *
 * ponytail: duplicated in `deploys/get-detail.ts`. Lift it into `domain/` if
 * a third caller appears.
 */
function evidenceOf(debug: unknown): string | null {
  if (debug === null || debug === undefined) return null;
  if (typeof debug === 'string') return debug.trim() === '' ? null : debug;
  const serialised = JSON.stringify(debug);
  if (serialised === undefined || serialised === '{}' || serialised === '[]') {
    return null;
  }
  return serialised;
}

/**
 * How many job runs the screen asks for. The App chart's CronJob keeps the same
 * number of runs, so on kubernetes it is also the retention depth.
 *
 * ponytail: other backends keep their own run count and report it nowhere.
 * Return the depth from `executions` if an adapter can observe it.
 */
const RETAINED_RUNS = 10;

interface PlacedJob {
  /** The adapter's opaque handle; null until an `apply` placed something. */
  readonly ref: string | null;
  readonly target: {
    readonly id: string;
    readonly adapter: TargetAdapter;
    readonly connection: TargetConnection | null;
    readonly vessel: {
      readonly name: string;
      readonly location: VesselLocation | null;
      readonly servedHosts: readonly string[] | null;
      readonly reachableRegistries: readonly string[] | null;
    } | null;
  } | null;
}

/**
 * The runs a job has had, read live from the platform. A failure returns an
 * empty state, and a failed list keeps the `executions` arm so Run now shows.
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
      because: `${targetLabel({ vessel: vessel.name, adapter: surface.adapter })} is not connected, so its runs cannot be read.`,
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
      because: `The runs on ${targetLabel({ vessel: vessel.name, adapter: surface.adapter })} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  // The ref names no job the adapter can report on, so nothing can run either.
  if (runs.kind === 'none') return { kind: 'none', because: runs.because };

  return {
    ...runnable,
    executions: runs.executions.map((execution) => ({
      name: execution.name,
      outcome: execution.outcome,
      detail: execution.detail ?? '',
      // Accepted but not started, so there is no start time yet.
      when:
        execution.startedAt === null
          ? 'just now'
          : elapsedSince(execution.startedAt, now),
    })),
  };
}

/**
 * A timeline title named by its attempt, such as Build 41, so build and
 * deploy lines differ. Build steps name their own phases, so it only lowercases.
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
