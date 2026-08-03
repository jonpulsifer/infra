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
 * **Claiming is `FOR UPDATE SKIP LOCKED`, and the claim is a leased phase.**
 * The lock on the Component@Target desired-state row is held only long enough
 * to move a Deploy to `APPLYING`; it is not held across the apply. Holding a
 * database transaction open for the length of a call to somebody else's
 * control plane would put a rollout's duration inside a lock. The phase and its
 * timestamp survive the process, and an abandoned claim becomes eligible after
 * the adapter convergence budget.
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
import { and, asc, eq, gt, inArray, lte, notExists, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type {
  DeployAdapter,
  DeployEvent,
  DeployPhase,
  DeployVerdict,
  ObservedState,
} from '../adapters/deploy/contract.ts';
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
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
import { displayUrl, hostnameFor } from '../domain/naming.ts';
import { DEFAULT_PLATFORM } from '../domain/placement.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  type TargetWithConnection,
} from '../domain/target.ts';

/** What the loop needs. No principal: nobody asked for it to run. */
export interface DeployLoopContext {
  readonly db: Database;
  readonly adapters: Pick<AdapterRegistry, 'deploy'>;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

/**
 * The phases that mean something is still owed work (§6).
 *
 * `PENDING` is here alongside §6's two in-flight phases because an intent nobody
 * has claimed is the most urgent thing there is — it is a developer waiting.
 * `APPLYING` and `WAITING` appear *between* passes only when an attempt did not
 * finish inside one: a reconciler that died mid-apply leaves exactly that, and
 * the fast cadence is how it gets picked back up rather than sitting for the
 * converged interval.
 */
const UNSETTLED: readonly DeployPhase[] = ['PENDING', 'APPLYING', 'WAITING'];
const IN_FLIGHT: readonly DeployPhase[] = ['APPLYING', 'WAITING'];

/** A crashed worker's phase remains durable, then becomes safely reclaimable. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60_000;

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
 * Fast only while something is unsettled. §6 is explicit that drift is
 * "information, not an alarm", so the converged cadence is minutes: polling a
 * settled workload every two seconds would be a watch built out of polls, which
 * is the thing this design declined.
 *
 * **The phases must come from the database, not from what the last pass
 * returned.** A pass only ever returns terminal outcomes — an attempt runs to
 * `LIVE` or `FAILED` inside it — so deciding from those would mean the fast
 * cadence never once fired, and the adaptive interval would be a fixed one
 * wearing a switch.
 */
export function intervalFor(
  phases: readonly DeployPhase[],
  intervals: LoopIntervals = DEFAULT_INTERVALS,
): number {
  return phases.some((phase) => UNSETTLED.includes(phase))
    ? intervals.fastMs
    : intervals.slowMs;
}

/**
 * The phases of everything still owed work, straight from the database.
 *
 * Read after a pass rather than derived from it, so an intent that arrived while
 * the pass was running is picked up on the fast cadence instead of waiting out a
 * converged interval.
 */
export async function unsettledPhases(
  context: DeployLoopContext,
): Promise<readonly DeployPhase[]> {
  const rows = await context.db
    .select({ phase: deploys.phase })
    .from(deploys)
    .where(inArray(deploys.phase, [...UNSETTLED]));
  return rows.map((row) => row.phase);
}

/**
 * Take one eligible Deploy and mark it `APPLYING`, or return `null`.
 *
 * `SKIP LOCKED` on the durable Component@Target row lets more than one
 * `reconciler` run without either waiting on the other or picking a newer intent
 * for the same workload. In-flight phases are leases: a recent one blocks the
 * pair, while an old one is safe to retry through the idempotent adapter seam.
 */
export async function claimNextDeploy(
  context: DeployLoopContext,
): Promise<Deploy | null> {
  const now = context.clock.now();
  const staleBefore = new Date(now.getTime() - DEFAULT_CLAIM_TIMEOUT_MS);
  return context.db.transaction(async (tx) => {
    const activeDeploys = alias(deploys, 'active_deploys');
    const [row] = await tx
      .select({ deploy: deploys })
      .from(deploys)
      .innerJoin(
        componentTargetDesired,
        and(
          eq(componentTargetDesired.componentId, deploys.componentId),
          eq(componentTargetDesired.targetId, deploys.targetId),
        ),
      )
      .where(
        and(
          or(
            eq(deploys.phase, 'PENDING'),
            and(
              inArray(deploys.phase, [...IN_FLIGHT]),
              lte(deploys.updatedAt, staleBefore),
            ),
          ),
          // A recent in-flight Deploy owns this Component@Target. Newer intents
          // wait rather than racing it, and a stale phase can be retried.
          notExists(
            tx
              .select({ id: activeDeploys.id })
              .from(activeDeploys)
              .where(
                and(
                  eq(activeDeploys.componentId, deploys.componentId),
                  eq(activeDeploys.targetId, deploys.targetId),
                  inArray(activeDeploys.phase, [...IN_FLIGHT]),
                  gt(activeDeploys.updatedAt, staleBefore),
                ),
              ),
          ),
        ),
      )
      // Oldest intent first: a queue that reordered itself would make two
      // deploys of one Component@Target land in an order nobody asked for.
      .orderBy(asc(deploys.id))
      .limit(1)
      // Lock the pair's durable desired row rather than only one Deploy row.
      // Concurrent replicas then skip the whole pair, not merely its oldest
      // intent and move on to a newer one for the same workload.
      .for('update', { of: componentTargetDesired, skipLocked: true });

    if (row === undefined) return null;

    await tx
      .update(deploys)
      .set({ phase: 'APPLYING', updatedAt: now })
      .where(eq(deploys.id, row.deploy.id));

    return { ...row.deploy, phase: 'APPLYING' as const, updatedAt: now };
  });
}

/** Everything one attempt needs, read once. */
interface AttemptSubject {
  readonly deploy: Deploy;
  readonly app: typeof apps.$inferSelect;
  readonly component: typeof components.$inferSelect;
  readonly build: typeof builds.$inferSelect;
  readonly target: TargetWithConnection<typeof targets.$inferSelect>;
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
  /**
   * Whether this Component may carry the App's vanity name.
   *
   * §9 puts the vanity name on the **App** — "the name a developer shares" — and
   * the canonical name on each Component. An App with two network-serving
   * Components therefore has one vanity name and two claimants, and handing it to
   * both puts the same hostname on two HTTPRoutes: a collision the platform
   * resolves arbitrarily, which is worse than not having the name at all.
   *
   * So it goes to a sole network-serving Component and otherwise to none. Picking
   * a winner among several would be a policy §9 does not state, and the developer
   * is the one who knows which of their Components is the front door.
   */
  vanityIsUnambiguous: boolean,
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
    // The Deploy's own reach and auth, not the Component's current ones: this
    // attempt asked for what it asked for, and a Component edited since must
    // not retroactively change what a running attempt is placing.
    reach: deploy.reach ?? component.reach,
    auth: deploy.auth ?? component.auth,
    ...(component.schedule === null ? {} : { schedule: component.schedule }),
    // §10: the document this Deploy recorded when its intent was written, not
    // whatever config says now. An attempt that re-read the items would deliver
    // a configuration nobody asked for, and a rollback would come back up with
    // the config of the release it was rolling away from.
    config: deploy.configDocument ?? [],
    requirements: { platform: DEFAULT_PLATFORM, resources: {} },
    hostname: hostnameFor({
      app: app.name,
      component: component.name,
      adapter: target.adapter,
      reach: deploy.reach ?? component.reach,
      zones: manifest.dns.zones,
      vanityLabel: vanityIsUnambiguous ? app.vanityDomain : null,
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
  const desired = desiredStateFor(
    subject,
    context.manifest,
    await soleServingComponent(context, subject),
  );
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

  return settle(context, subject, desired, verdict);
}

/**
 * Whether this Component is the only network-serving one its App has.
 *
 * A job serves nothing, and an unexposed service is a queue worker (§2), so
 * neither can claim the App's front-door name.
 */
async function soleServingComponent(
  context: DeployLoopContext,
  subject: AttemptSubject,
): Promise<boolean> {
  const siblings = await context.db
    .select({
      id: components.id,
      kind: components.kind,
      expose: components.expose,
    })
    .from(components)
    .where(eq(components.appId, subject.app.id));

  const serving = siblings.filter(
    (sibling) => sibling.kind === 'website' || sibling.expose === true,
  );
  return serving.length === 1 && serving[0]?.id === subject.component.id;
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
  desired: DesiredState,
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
      verdict.url ?? displayUrl({ canonical: desired.hostname.canonical });

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
        // A deploy that just landed is by definition what was asked for. Left
        // set, a previous attempt's drift would follow the new release around.
        driftedAt: null,
        observedDigest: desired.artifact.digest,
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

/** One pass of `observe` over what has converged, to notice drift (§6). */
export interface DriftReport {
  readonly deployId: number;
  readonly drifted: boolean;
  readonly observedDigest: string | null;
  /** Why the platform will not converge, when that is what drifted. */
  readonly driftDetail: string | null;
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
  const now = context.clock.now();
  const live = await context.db
    .select()
    .from(deploys)
    .where(eq(deploys.phase, 'LIVE'));

  const reports: DriftReport[] = [];
  for (const deploy of live) {
    if (deploy.ref === null || deploy.orphanedAt !== null) continue;
    const subject = await subjectOf(context, deploy);
    if (subject === null) continue;

    let state: ObservedState | null = null;
    try {
      state = await subject.adapter.observe(
        deployTargetOf(subject.target),
        deploy.ref,
      );
    } catch {
      // A Target that cannot be reached is not a Target that has drifted. Saying
      // "drifted" here would turn every uplink blip into a false alarm about
      // something a developer did.
      continue;
    }
    const observed = state?.artifactDigest ?? null;

    const drifted = hasDrifted({
      phase: deploy.phase,
      desiredDigest: subject.build.artifactDigest ?? '',
      observedDigest: observed,
      ...(state === null ? {} : { observedPhase: state.phase }),
    });

    // The platform's own sentence, kept only while it is the reason. §12's
    // argument for storing a diagnosis applies here for the same cause: a
    // Helm error naming the value that no longer renders is not recoverable
    // from anywhere once the object is reconciled again.
    const driftDetail =
      drifted && state?.phase === 'FAILED' ? (state.detail ?? null) : null;

    // §6 wants drift to be "a visible state", and visible means a row: the UI
    // reads rows, so a finding that lived only for the length of this pass
    // would be surfaced to nobody. Cleared when it matches again, so drift
    // somebody fixed out of band stops being reported without a dismissal.
    if (
      drifted !== (deploy.driftedAt !== null) ||
      observed !== deploy.observedDigest ||
      driftDetail !== deploy.driftDetail
    ) {
      await context.db
        .update(deploys)
        .set({
          driftedAt: drifted ? now : null,
          observedDigest: observed,
          driftDetail,
          updatedAt: now,
        })
        .where(eq(deploys.id, deploy.id));
    }

    reports.push({
      deployId: deploy.id,
      drifted,
      observedDigest: observed,
      driftDetail,
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
  const target = row.target;
  if (!hasTargetConnection(target)) return null;

  const adapter = context.adapters.deploy(target.adapter);
  if (adapter === null) return null;

  return {
    deploy,
    ...row,
    target,
    adapter,
  };
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
  /**
   * What is still owed work when the pass ended, read from the database.
   *
   * This — not {@link applied} — is what sets the next interval. A pass returns
   * terminal outcomes only, so choosing from those could never select the fast
   * cadence.
   */
  readonly unsettled: readonly DeployPhase[];
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
  return {
    applied,
    drift: await observeConverged(context),
    unsettled: await unsettledPhases(context),
  };
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

    await sleep(intervalFor(pass.unsettled, intervals), options);
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
