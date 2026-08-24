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
import { type Command, type CommandContext, failed, ok } from '../types.ts';
import type {
  ActivityEntry,
  BuildRouteOptionView,
  ComponentView,
  DatastoreView,
  DeployPhase,
  Diagnosis,
  DriftView,
  PrerequisiteRowView,
  Runtime,
  WorkspaceView,
} from '../views.ts';
import { namesUnder, placementsFor } from './names.ts';

export const getAppWorkspaceInput = z.object({
  name: z.string().min(1),
  /**
   * Which Component the screen is showing, by name.
   *
   * The App-first view is one screen with a selection in it, not a screen per
   * Component — so this narrows what the per-Component half of
   * {@link WorkspaceView} is read from and nothing else. Absent is the App's
   * first Component, which is what a screen opened without a selection shows.
   *
   * A name rather than an id because `components` is unique per App and this is
   * a read of one App: the name is enough to resolve, and it is what the row a
   * person pressed says. It is its own field rather than a pair with a Target
   * for the same reason — a second dimension is a second field here, not a
   * different shape.
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
        // Oldest first, so "the App's first Component" names one Component
        // rather than whichever row the planner returned first — the default
        // selection is read from this order on every load of the screen.
        orderBy: (comps, { asc }) => [asc(comps.createdAt)],
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
          // The placement of record — the stored fact `deployApp` acts on,
          // with its vessel because the screen states the boundary from it.
          placedTarget: { with: { vessel: true } },
          // The pairs that still serve. `placeComponent` leaves the old pair's
          // desired row behind on purpose — "what is live there keeps serving
          // until `unplaceComponent` retires it" (`components/place.ts:22-24`)
          // — and this relation had never been read anywhere in `src/`, which
          // is exactly why that command has had no control: nothing could name
          // the pair to retire. Per row rather than for the selection alone,
          // because this list already states each Component's placement and a
          // second Target that is still serving is the same kind of fact.
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

  // The Component the screen is showing. Every per-Component read below hangs
  // off this one — its runtime, the Target it is placed on, its config — so a
  // job behind a service is reachable by naming it rather than by being first.
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
  // The placement of record, never deploy history: the screen names the Target
  // the deploy button would act on, including for a moved-but-never-deployed
  // Component — where history would name the Target it moved away from.
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
      // Placement per row, so a multi-Component App stops hiding two thirds of
      // itself behind the selection. The hero states where the *selected*
      // Component is; without these the others' placement was reachable only by
      // pressing each row in turn, which is the one thing a list exists to
      // spare a reader.
      ...(placed === undefined ? {} : { target: targetRowLabel(placed) }),
      // Sorted by label so the list a person reads is stable across loads:
      // the rows come back in whatever order the planner returned them, and a
      // pair that moves position between two reads of the same screen reads as
      // a pair that changed.
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

  // Keyed on the id, never the name. The unique key on `datastores` is
  // (vessel_id, name), so two Vessels may each legitimately hold a `primary` —
  // a name-keyed map dropped the second one silently, and the row that
  // vanished would be exactly the one an operator came here to find. The id is
  // what every act on this row resolves on, so it is carried regardless, and
  // with it on the row the two lists are disjoint by construction: `appId` is
  // this App's or it is null.
  const datastoresMap = new Map<string, DatastoreView>();

  for (const ds of [...app.datastores, ...unattachedDatastores]) {
    datastoresMap.set(ds.id, {
      id: ds.id,
      name: ds.name,
      engine: ds.engine,
      provenance: ds.provenance,
      // A Datastore is attached to the App (§11), so the Component named here
      // is the App's first and never the selection: the same store reporting
      // two different attachments as the selection moves is a second answer to
      // a question that has one.
      attachedTo:
        ds.appId === null ? null : (app.components[0]?.name ?? app.name),
      target: datastoreVesselLabel(ds.vessel),
      // What it is doing, and why it is doing it. A managed store converges
      // like a Deploy does, so a row without these read as finished the
      // instant it was asked for and as broken while it was bootstrapping.
      phase: ds.phase,
      ...(ds.detail === null ? {} : { detail: ds.detail }),
    });
  }

  // Keys only, never values (§10) — `configuredKeys` is the same read
  // `setConfig` itself uses to know what is already there, and it is the
  // only shape a screen is allowed to show: core's store has no verb that
  // returns a value. Scoped to the same pair the rest of this screen already
  // picked — the selected Component and `workspaceTarget`, not every Target it
  // might be placed on — because that pair is what a `Set variable` here would
  // act on.
  const configKeys =
    selected && workspaceTarget
      ? await configuredKeys(context.db, selected.id, workspaceTarget.id)
      : [];

  // Attempt-level status events only — the checkpoints, not the transcript.
  //
  // Every log line an adapter emits lands in `attempt_events` too, and reading
  // the table raw made the timeline the last twenty lines of whatever ran most
  // recently: three screens of BuildKit chatter where a reader wanted "built,
  // deployed, went red".
  //
  // `eventType = 'status'` was believed to be the whole of that filter and is
  // not. §6's shape is `{phase, resource?, reason?}`, and **a status event
  // carrying a `resource` is one step or one Kubernetes object inside an
  // attempt**, not a state of the attempt itself: the Actions poller writes one
  // per (job, step, state), so a single build produced twenty of them and each
  // one titled itself "Build 23 succeeded", the step name demoted to a grey
  // subtitle. Ten rows of one build, and every real checkpoint — the deploy,
  // the build before it — evicted by the limit. The exact sequence this
  // timeline exists to show was the thing it could no longer show.
  //
  // Those rows already have a home: `builds/view.ts` and `deploys/get-detail.ts`
  // build their per-resource checklists from precisely the events this now
  // excludes, selecting on the same column from the other side.
  //
  // Ten, and this is the only bound: the workspace renders what it is given, so
  // a second limit in the view could only disagree with this one.
  const events = await context.db.query.attemptEvents.findMany({
    where: (ev, { eq, and, isNull }) =>
      and(
        eq(ev.appId, app.id),
        eq(ev.eventType, 'status'),
        isNull(ev.resource),
      ),
    orderBy: (ev, { desc }) => [desc(ev.id)],
    limit: 10,
  });

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
        // A Build ends at SUCCEEDED and a Deploy ends at LIVE. Reading only the
        // Deploy's word for it left every finished Build wearing the neutral
        // marker, so a column of checkpoints showed nothing having gone right.
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
      title: `Deploy ${latestDeploy.id} ${latestDeploy.phase.toLowerCase()}`,
      detail: latestDeploy.detail ?? `Target: ${targetRowLabel(latestTarget)}`,
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
  } else if (selected?.builds[0]) {
    // A freshly created App's first Build, before it has emitted an
    // attempt-level checkpoint of its own. Every status event a running build
    // writes carries a `resource` — one per step — so the filter above sees
    // nothing until the build ends, and the deploy arm has no Deploy to fall
    // back to: the timeline said "Nothing has happened yet" over the build the
    // create flow had just started, with no way in to it from this screen.
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

  // Which Components serve, by the same rule the reconciler publishes by.
  // §9 puts the shared name on the App, and `deploy-loop.ts` refuses to guess
  // which of two serving Components it means — so an App with two publishes no
  // vanity record at all.
  const serving = app.components.filter(servesNetwork);
  const vanityIsPublished = serving.length === 1;
  const placements = await placementsFor(context.db, app.id);
  // The App's shared name as a hostname rather than as the label it is stored
  // as. `@` is a spelling of "the zone itself" and is not an address; putting
  // it on a screen that calls the field a url produced a link to `https://@`.
  const vanityZone =
    vanityIsPublished && app.vanityDomain !== null && selected !== undefined
      ? zoneFor(selected.reach, context.manifest.dns.zones, app.zone)
      : null;
  const vanityHost =
    vanityZone === null || app.vanityDomain === null
      ? ''
      : vanity(app.vanityDomain, vanityZone);

  // The address the selected Component answers on. A job answers on none — no
  // adapter puts a url on a job's Deploy — and the App's vanity domain is not
  // one either: the fallback is for a Component that will serve that domain and
  // has not deployed yet, which a job never is.
  //
  // Nor is it one while two Components serve. The reconciler will never publish
  // that name, and printing it here as the App's address was the screen
  // asserting something the thing that publishes had already refused.
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

  /*
    Why the release went red, and what the platform has stopped agreeing with.

    Both facts are columns on the Deploy row this screen already reads, and
    until now both were rendered only at `/deploys/:id` — so the workspace said
    "has no release serving yet" over a failure with a recorded reason, and "is
    live" over a release the cluster had been refusing for two days. The panels
    that render them were already written and already take exactly these shapes.
  */
  const diagnosis: Diagnosis | null =
    latestDeploy?.phase === 'FAILED' && latestDeploy.reason
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

  /*
    The rows behind `prerequisitesMet: false`.

    `health` is every catalogued row met, so the boolean the screen had was the
    conclusion with the evidence thrown away — "A prerequisite is unmet" is a
    dead end on the one screen where an operator is asking which one. These are
    the stored results of the standing pass, unmet only, and without the
    generated remediation: the change that clears a row is §13's to compose and
    the Targets screen has the manifest and the boundary in hand to do it. This
    names what is blocking and points there.
  */
  const unmetPrerequisites: readonly PrerequisiteRowView[] = (
    workspaceTarget?.prerequisites ?? []
  )
    .filter((row) => !row.met)
    .map((row) => ({
      name: row.name,
      met: false,
      ...(row.detail === undefined ? {} : { detail: row.detail }),
    }));

  // The App's own opinion (§4, §16) — never asked of an archive App, for the
  // same reason `autoDeploy` below is not: §4's supplied artifact "consults no
  // route at all", so there is nothing here to choose.
  const buildRoute = app.sourceKind === 'repo' ? app.buildRoute : null;

  /*
    Every configured route, judged against the placed Target's minimum level
    alone. `buildRouteFor` runs with no App id, exactly as `setAppBuildRoute`
    itself calls it to validate a route before writing one
    (`commands/apps/build-route.ts:127`) — so an option this screen offers as
    eligible is one that call would not refuse on the level threshold. Passing
    the App's id here instead would narrow the candidates to whichever route it
    has already chosen (`buildRouteFor`'s own `demand.routes`), which is right
    for dispatch and wrong for a picker whose whole job is offering the other
    routes to switch to.

    The registry half `setAppBuildRoute` also checks is a live round trip this
    read does not repeat; an option eligible here can still be refused on
    submit for that reason, exactly as the level threshold is a necessary but
    not sufficient check for `buildRouteFor` itself.
  */
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
    // An address that is serving, which is not the same as a release that is
    // live: a placed job is LIVE with nothing to open, and this is the fact the
    // screen's link and its headline hang off.
    urlLive: url !== '' && latestDeploy?.phase === 'LIVE',
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
    // Stated rather than inferred from the two nulls above. Both are null for
    // an archive App *and* for a repo App whose route is unset, so a screen
    // reading them cannot tell the cases apart — which is why the archive App's
    // missing route picker and missing auto-deploy toggle had no explanation on
    // them, and why `deployApp`'s "upload an archive for this Component" named
    // an act nothing offered.
    // The same preview `setAppZone` and `setAppVanity` answer with, so the
    // screen that sets the name and the commands that write it cannot state the
    // outcome two different ways.
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
    archiveSourced: app.sourceKind !== 'repo',
    buildRoute,
    buildRouteOptions,
    // What the release delivered and when, so `LIVE` stops being a word with
    // no date on it. Absent rather than empty for an App that has never
    // deployed: there is no commit and no instant, and a blank line where a
    // commit goes reads as one that failed to load.
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
  };

  return ok({ workspace });
};

/**
 * §6's raw `debug` payload as a screen can read it, or `null` where core
 * recorded nothing.
 *
 * Serialising an absence yields `"{}"`, which is not evidence, is not what any
 * runner emitted, and is truthy enough to be mistaken for both — so nothing is
 * reported as nothing, and `DiagnosisPanel` gets to omit the disclosure rather
 * than open one over an empty pane.
 *
 * ponytail: the same seven lines as `deploys/get-detail.ts`, which is the only
 * other command that reads this column. Duplicated rather than shared because
 * two callers is not a module; lift it into `domain/` if a third appears.
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
