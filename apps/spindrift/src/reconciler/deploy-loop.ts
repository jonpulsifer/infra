/**
 * The deploy loop (§6, Task 20).
 *
 * §6 puts reconciliation in core, above the adapter seam: the verbs are one-shot
 * and imperative, "every backend self-heals below the seam, so an adapter never
 * holds a workload up". This file is that above — the thing that decides *when*
 * to act and *when* to look.
 *
 * **Poll, not watch.** Three reasons, and only the first is about Kubernetes:
 * one of the three backends has a watch and the other two do not, so an
 * event-driven seam would have two shapes; a watch held across a satellite uplink
 * dies while still looking connected, which is the one failure mode a
 * convergence loop must not have; and hand-rolled watch bookkeeping in
 * TypeScript with no informer is real work for no gain at this scale.
 *
 * **The interval is adaptive, not fixed** (see {@link intervalFor}). Fast while
 * an attempt is in flight — a bounded window, not a standing watch — and slow
 * once converged, where the slow cadence *is* the drift detection §6 asks for.
 *
 * **Claiming is `FOR UPDATE SKIP LOCKED`, and the claim is a phase, not a lock.**
 * The lock is held only long enough to move a row `PENDING -> APPLYING`; it is not
 * held across the apply. Holding a database transaction open for the length of a
 * call to somebody else's control plane would put a rollout's duration inside a
 * lock, and a `reconciler` that died mid-apply would leave the row locked until
 * the connection timed out. A phase survives the process; a lock does not.
 *
 * **`LISTEN`/`NOTIFY` is an optimization and never the delivery path.** It is
 * free with the Postgres already required and it cuts intent-to-pickup latency
 * from one interval to nearly nothing — but `NOTIFY` is *lost* when no listener
 * is connected, so a loop that depended on it would silently stop converging
 * across a `reconciler` restart. Everything here is correct with every
 * notification dropped: the wake-up only shortens a sleep, and
 * `test/reconciler/deploy-loop.test.ts` runs the whole convergence with
 * notifications disabled to keep that true.
 */
import { asc, eq } from 'drizzle-orm';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployVerdict,
} from '../adapters/deploy/contract.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import {
  apps,
  builds,
  components,
  type Deploy,
  deploys,
  targets,
} from '../db/schema.ts';
import { recordDeployEvent } from '../domain/attempt-log.ts';
import type { DesiredState } from '../domain/desired-state.ts';
import {
  diagnosisOf,
  failureColumns,
  hasDrifted,
} from '../domain/diagnosis.ts';
import { hostnameFor } from '../domain/naming.ts';
import { DEFAULT_PLATFORM } from '../domain/placement.ts';
import { deployTargetOf } from '../domain/target.ts';

/** What the loop needs. No principal: nobody asked for it to run. */
export interface DeployLoopContext {
  readonly db: Database;
  readonly adapters: Pick<AdapterRegistry, 'deploy'>;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

/** The phases an attempt is still in flight in (§6). */
const IN_FLIGHT: readonly DeployPhase[] = ['APPLYING', 'WAITING'];

/** How often to look, given what the Deploy is doing (§6, plan Transport). */
export interface LoopIntervals {
  /** While an attempt is converging. Short, and bounded by the attempt. */
  readonly fastMs: number;
  /** Once converged. Also the drift-detection cadence — drift is information. */
  readonly slowMs: number;
}

export const DEFAULT_INTERVALS: LoopIntervals = {
  fastMs: 2_000,
  slowMs: 5 * 60_000,
};

/**
 * The interval to wait before looking again.
 *
 * Fast only while something is in flight. §6 is explicit that drift is
 * "information, not an alarm", so the converged cadence is minutes: polling a
 * settled workload every two seconds would be a watch built out of polls, which
 * is the thing this design declined.
 */
export function intervalFor(
  phases: readonly DeployPhase[],
  intervals: LoopIntervals = DEFAULT_INTERVALS,
): number {
  return phases.some((phase) => IN_FLIGHT.includes(phase))
    ? intervals.fastMs
    : intervals.slowMs;
}

/**
 * Take one `PENDING` Deploy and mark it `APPLYING`, or return `null`.
 *
 * `SKIP LOCKED` is what lets more than one `reconciler` run without either
 * waiting on the other or both picking up the same row: a contended row is
 * skipped rather than queued behind, so a second worker moves on to the next
 * intent instead of stalling on the first.
 */
export async function claimNextDeploy(
  context: DeployLoopContext,
): Promise<Deploy | null> {
  const now = context.clock.now();
  return context.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(deploys)
      .where(eq(deploys.phase, 'PENDING'))
      // Oldest intent first: a queue that reordered itself would make two
      // deploys of one Component@Target land in an order nobody asked for.
      .orderBy(asc(deploys.id))
      .limit(1)
      .for('update', { skipLocked: true });

    if (row === undefined) return null;

    await tx
      .update(deploys)
      .set({ phase: 'APPLYING', updatedAt: now })
      .where(eq(deploys.id, row.id));

    return { ...row, phase: 'APPLYING' as const };
  });
}

/** Everything one attempt needs, read once. */
interface AttemptSubject {
  readonly deploy: Deploy;
  readonly app: typeof apps.$inferSelect;
  readonly component: typeof components.$inferSelect;
  readonly build: typeof builds.$inferSelect;
  readonly target: typeof targets.$inferSelect;
  readonly adapter: DeployAdapter;
}

/**
 * Assemble the neutral `DesiredState` core hands the adapter (§6).
 *
 * "**Core describes; the adapter renders.**" Nothing here is a Kubernetes field,
 * a Cloud Run field, or a hosting field — this is the vocabulary all three are
 * rendered from, and a field this function cannot fill is a field core does not
 * get to describe.
 */
export function desiredStateFor(
  subject: AttemptSubject,
  manifest: InstallationManifest,
): DesiredState {
  const { deploy, app, component, build, target } = subject;
  return {
    deploy: String(deploy.id),
    app: app.name,
    component: component.name,
    target: target.name,
    kind: component.kind,
    artifact: {
      type: build.artifactType,
      digest: build.artifactDigest ?? '',
      refs: build.artifactRefs ?? [],
    },
    ...(component.expose === null ? {} : { expose: component.expose }),
    // The Deploy's own exposure, not the Component's current one: this attempt
    // asked for what it asked for, and a Component edited since must not
    // retroactively change what a running attempt is placing.
    exposure: deploy.exposure ?? component.exposure,
    ...(component.schedule === null ? {} : { schedule: component.schedule }),
    // §10's config arrives with Milestone 6. Empty is honest: no config item has
    // been written yet, so there is no pinned reference to deliver.
    config: [],
    requirements: { platform: DEFAULT_PLATFORM, resources: {} },
    hostname: hostnameFor({
      app: app.name,
      component: component.name,
      adapter: target.adapter,
      apexZone: manifest.dns.apexZone,
      vanityZone: manifest.dns.vanityZone,
      vanityLabel: app.vanityDomain,
    }),
  };
}

/** What one attempt did. */
export interface AttemptOutcome {
  readonly deployId: number;
  readonly phase: 'LIVE' | 'FAILED';
  readonly url: string | null;
}

/**
 * Run one claimed Deploy to a terminal verdict.
 *
 * **Phases come from the adapter, never from core's own opinion** (§6: "phase
 * transitions come from the controller or platform API — never Spindrift
 * reimplementing readiness"). Every status event the adapter yields is written to
 * both the Deploy row and the attempt log, so what the UI reads is what the
 * platform said, in the order it said it.
 *
 * `apply` does not throw by contract, but an adapter is code and code throws. A
 * thrown error becomes `INTERNAL` — blamed on the platform by §6's table — rather
 * than escaping into the loop, because an attempt that ends by crashing the
 * reconciler is an attempt that stays `APPLYING` forever.
 */
export async function runAttempt(
  context: DeployLoopContext,
  deploy: Deploy,
): Promise<AttemptOutcome | null> {
  const subject = await subjectOf(context, deploy);
  if (subject === null) return null;

  const attempt = {
    appId: subject.app.id,
    componentId: subject.component.id,
    deployId: deploy.id,
  };
  const desired = desiredStateFor(subject, context.manifest);
  const targetRef = deployTargetOf(subject.target);

  let verdict: DeployVerdict;
  try {
    const stream = subject.adapter.apply(targetRef, desired);
    let next = await stream.next();
    while (!next.done) {
      await absorb(context, attempt, deploy.id, next.value);
      next = await stream.next();
    }
    verdict = next.value;
  } catch (cause) {
    verdict = {
      phase: 'FAILED',
      reason: 'INTERNAL',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  }

  return settle(context, subject, verdict);
}

/** Write one adapter event to the log, and its phase to the row. */
async function absorb(
  context: DeployLoopContext,
  attempt: { appId: string; componentId: string; deployId: number },
  deployId: number,
  event: DeployEvent,
): Promise<void> {
  if (event.type === 'log') {
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line: event.line,
      ...(event.resource === undefined ? {} : { resource: event.resource }),
    });
    return;
  }

  await recordDeployEvent(context.db, attempt, {
    type: 'status',
    phase: event.phase,
    ...(event.resource === undefined ? {} : { resource: event.resource }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  });

  // Only the non-terminal phases are taken from the stream. The terminal one is
  // written once, with the verdict, so a stream that yields FAILED and then
  // returns LIVE cannot leave the row disagreeing with the verdict.
  if (event.phase === 'APPLYING' || event.phase === 'WAITING') {
    await context.db
      .update(deploys)
      .set({ phase: event.phase, updatedAt: context.clock.now() })
      .where(eq(deploys.id, deployId));
  }
}

/** Persist the terminal verdict, and the diagnosis if there is one. */
async function settle(
  context: DeployLoopContext,
  subject: AttemptSubject,
  verdict: DeployVerdict,
): Promise<AttemptOutcome> {
  const now = context.clock.now();
  const deployId = subject.deploy.id;
  const attempt = {
    appId: subject.app.id,
    componentId: subject.component.id,
    deployId,
  };

  if (verdict.phase === 'LIVE') {
    // §9: where the platform names its own, the canonical comes back across the
    // seam. Where core minted one, the adapter has nothing to add and core's
    // name stands.
    const url =
      verdict.url ??
      urlOf(desiredStateFor(subject, context.manifest).hostname.canonical);

    await context.db
      .update(deploys)
      .set({
        phase: 'LIVE',
        ref: verdict.ref,
        url,
        reason: null,
        blame: null,
        detail: null,
        debug: null,
        updatedAt: now,
      })
      .where(eq(deploys.id, deployId));

    await recordDeployEvent(context.db, attempt, {
      type: 'status',
      phase: 'LIVE',
    });
    return { deployId, phase: 'LIVE', url };
  }

  const diagnosis = diagnosisOf(verdict);
  // §12: the platform will not keep this. Cluster events expire in about an
  // hour, so what is written here is the only copy that will exist tomorrow.
  await context.db
    .update(deploys)
    .set({
      ...failureColumns(diagnosis!),
      ...(verdict.ref === undefined ? {} : { ref: verdict.ref }),
      updatedAt: now,
    })
    .where(eq(deploys.id, deployId));

  await recordDeployEvent(context.db, attempt, {
    type: 'status',
    phase: 'FAILED',
    reason: verdict.reason,
  });

  // Nothing here touches `exposure` — §9: "exposure never mutates on red." The
  // previous release is still serving, and quietly making it unreachable would
  // turn one failed deploy into an outage.
  return { deployId, phase: 'FAILED', url: null };
}

function urlOf(canonical: string): string | null {
  return canonical === '' ? null : `https://${canonical}`;
}

/** One pass of `observe` over what has converged, to notice drift (§6). */
export interface DriftReport {
  readonly deployId: number;
  readonly drifted: boolean;
  readonly observedDigest: string | null;
}

/**
 * Look at what is actually running, and say so.
 *
 * **Never corrects anything.** §6: "drift is detected and surfaced, never
 * silently corrected — a visible state with a one-click re-converge." The
 * re-converge is an ordinary Deploy somebody presses, so this function returns a
 * report and writes no desired state. A loop that healed drift on its own would
 * also happily undo a deliberate manual change during an incident.
 */
export async function observeConverged(
  context: DeployLoopContext,
): Promise<readonly DriftReport[]> {
  const live = await context.db
    .select()
    .from(deploys)
    .where(eq(deploys.phase, 'LIVE'));

  const reports: DriftReport[] = [];
  for (const deploy of live) {
    if (deploy.ref === null || deploy.orphanedAt !== null) continue;
    const subject = await subjectOf(context, deploy);
    if (subject === null) continue;

    let observed: string | null = null;
    try {
      const state = await subject.adapter.observe(
        deployTargetOf(subject.target),
        deploy.ref,
      );
      observed = state?.artifactDigest ?? null;
    } catch {
      // A Target that cannot be reached is not a Target that has drifted. Saying
      // "drifted" here would turn every uplink blip into a false alarm about
      // something a developer did.
      continue;
    }

    reports.push({
      deployId: deploy.id,
      drifted: hasDrifted({
        phase: deploy.phase,
        desiredDigest: subject.build.artifactDigest ?? '',
        observedDigest: observed,
      }),
      observedDigest: observed,
    });
  }
  return reports;
}

/** Read everything one Deploy refers to, or `null` if it is not runnable. */
async function subjectOf(
  context: DeployLoopContext,
  deploy: Deploy,
): Promise<AttemptSubject | null> {
  const [row] = await context.db
    .select({
      component: components,
      app: apps,
      build: builds,
      target: targets,
    })
    .from(deploys)
    .innerJoin(components, eq(deploys.componentId, components.id))
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(builds, eq(deploys.buildId, builds.id))
    .innerJoin(targets, eq(deploys.targetId, targets.id))
    .where(eq(deploys.id, deploy.id));

  if (row === undefined) return null;
  const adapter = context.adapters.deploy(row.target.adapter);
  if (adapter === null) return null;

  return { deploy, ...row, adapter };
}

/** How the loop runs, and how to stop it. */
export interface DeployLoopOptions {
  readonly intervals?: LoopIntervals;
  readonly signal?: AbortSignal;
  /**
   * An optional early wake-up — the `LISTEN/NOTIFY` leg.
   *
   * Resolves when something says an intent was written. **Purely an
   * optimization**: it can only shorten a sleep, never extend one, and a loop
   * that never sees a notification still converges on the poll interval. Omit it
   * and everything still works, only slower — which is exactly what the test
   * with notifications disabled asserts.
   */
  readonly wakeup?: (signal: AbortSignal) => Promise<void>;
  readonly onPass?: (pass: LoopPass) => void;
}

/** What one pass did, for whatever an installation wires to it. */
export interface LoopPass {
  readonly applied: readonly AttemptOutcome[];
  readonly drift: readonly DriftReport[];
}

/**
 * Drain every claimable intent, then look at what has converged.
 *
 * Draining rather than taking one per tick: a burst of intents should not take
 * one poll interval each to start, and the drain is bounded by how many rows are
 * actually `PENDING`.
 */
export async function runDeployPass(
  context: DeployLoopContext,
): Promise<LoopPass> {
  const applied: AttemptOutcome[] = [];
  for (;;) {
    const claimed = await claimNextDeploy(context);
    if (claimed === null) break;
    const outcome = await runAttempt(context, claimed);
    if (outcome !== null) applied.push(outcome);
  }
  return { applied, drift: await observeConverged(context) };
}

/** Run until aborted. */
export async function runDeployLoop(
  context: DeployLoopContext,
  options: DeployLoopOptions = {},
): Promise<void> {
  const intervals = options.intervals ?? DEFAULT_INTERVALS;
  while (!options.signal?.aborted) {
    const pass = await runDeployPass(context);
    options.onPass?.(pass);
    if (options.signal?.aborted) return;

    const phases = pass.applied.map((outcome) => outcome.phase);
    await sleep(intervalFor(phases, intervals), options);
  }
}

/** A sleep that wakes early on abort, or on a notification if one is wired. */
function sleep(ms: number, options: DeployLoopOptions): Promise<void> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const done = (): void => {
      clearTimeout(timer);
      controller.abort();
      resolve();
    };
    const timer = setTimeout(done, ms);
    options.signal?.addEventListener('abort', done, { once: true });
    // A rejected wake-up is a dropped notification, which the poll below already
    // tolerates — so it is swallowed rather than allowed to fail a pass.
    options.wakeup?.(controller.signal).then(done, () => {});
  });
}
