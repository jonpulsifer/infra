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
 * event-driven seam would have two shapes; a watch held across a WAN tunnel
 * dies while still looking connected, which is the one failure mode a
 * convergence loop must not have; and hand-rolled watch bookkeeping in
 * TypeScript with no informer is real work for no gain at this scale.
 *
 * **Two cadences, not one.** Looking for work is one cheap indexed `select`, so
 * it runs every second or two — a developer who pressed Deploy is waiting, and
 * the interval before pickup is the largest number they experience. Looking at
 * what has already converged costs one adapter round trip per live release, so
 * drift detection runs on its own far slower clock
 * ({@link DEFAULT_DRIFT_INTERVAL_MS}). Binding the two together made every
 * pickup wait out a drift interval, which is the wait this split removes.
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
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  notExists,
  or,
} from 'drizzle-orm';
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
  vessels,
} from '../db/schema.ts';
import { recordDeployEvent } from '../domain/attempt-log.ts';
import type { DesiredState } from '../domain/desired-state.ts';
import {
  diagnosisOf,
  failureColumns,
  hasDrifted,
  scheduleDrift,
} from '../domain/diagnosis.ts';
import {
  coreMintsCanonical,
  displayUrl,
  hostnameFor,
  isApexName,
  servesNetwork,
} from '../domain/naming.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
  type TargetWithConnection,
  type VesselRef,
} from '../domain/target.ts';
import { dnsHandleFor } from '../domain/workload-name.ts';
import {
  reconcilerAttemptDuration,
  reconcilerDriftedDeploys,
  reconcilerLoopDuration,
  reconcilerPickupLatency,
  reconcilerQueueDepth,
} from '../telemetry/index.ts';

/** What the loop needs. No principal: nobody asked for it to run. */
export interface DeployLoopContext {
  readonly db: Database;
  /**
   * `dns` alongside `deploy`: a LIVE verdict on a platform-named Target earns
   * a vanity record the way a cluster Target already earns one through its
   * own release (§9), and `settle` is what converges or withdraws it.
   */
  readonly adapters: Pick<AdapterRegistry, 'deploy' | 'dns'>;
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

/**
 * How often a running attempt says it is still there.
 *
 * The reclaim compares `updatedAt` against {@link DEFAULT_CLAIM_TIMEOUT_MS},
 * and the adapters that take longest emit nothing but `log` events while they
 * work — a sequential per-file upload writes no row update for its whole
 * duration, so a healthy twenty-minute apply looked exactly like a dead pod.
 * A timer refreshes the column the reclaim already reads, which covers the case
 * absorbing more event types cannot: a single hung HTTP call emits nothing at
 * all, and a `setInterval` keeps ticking through an `await` that never returns.
 *
 * Mirrors bosun's own `buildHeartbeatInterval` (`apps/bosun/spindrift.go`),
 * which keeps an outbox claim's lease alive the same way.
 */
export const DEPLOY_HEARTBEAT_MS = 60_000;

/**
 * The longest an attempt may keep refreshing its lease.
 *
 * Three times the adapters' own convergence deadline (their `DEFAULT_TIMEOUT_MS`
 * is ten minutes), and the cap is the whole point: an unbounded heartbeat is
 * exactly the hang it was meant to survive, because a call that never returns
 * would keep refreshing the lease forever and turn a self-healing stall into a
 * permanent one. Past this the lease ages out over the following
 * {@link DEFAULT_CLAIM_TIMEOUT_MS} and another reconciler takes the row, so a
 * hung apply is somebody else's again forty-five minutes after it was claimed —
 * which is safe only because {@link deploys.attemptId} stops the abandoned
 * attempt from writing anything when it finally comes back.
 */
export const DEPLOY_ATTEMPT_MAX_MS = 30 * 60_000;

/** How often to look for claimable work, given what is in flight (§6). */
export interface LoopIntervals {
  /** While an attempt is converging. Short, and bounded by the attempt. */
  readonly fastMs: number;
  /** With nothing unsettled. Still seconds: this is time-to-pickup. */
  readonly slowMs: number;
}

export const DEFAULT_INTERVALS: LoopIntervals = {
  fastMs: 1_000,
  slowMs: 2_000,
};

/**
 * How often converged releases are re-read to notice drift (§6).
 *
 * Minutes, and deliberately unrelated to {@link LoopIntervals}: §6 is explicit
 * that drift is "information, not an alarm", and one adapter round trip per
 * live release is not something to spend every second. Polling for *work* is a
 * `select`, so it stays fast; polling the platform is a network call, so it
 * stays slow.
 */
export const DEFAULT_DRIFT_INTERVAL_MS = 5 * 60_000;

/**
 * How long a `LIVE` release is left alone before its soak is judged.
 *
 * §6 makes `LIVE` the platform's readiness verdict and the attempt ends there —
 * so a workload that passes readiness and crashes two minutes later is a green
 * Deploy with a drift flag some minutes late and no blame. §6 forbids core
 * *reimplementing* readiness, not judging what happens after it: one look at
 * least this long after the verdict, and a `FAILED` observation then is a
 * `faulty` release with a reason and a blame (`judgeSoak`).
 *
 * A floor and not a schedule. The look is taken by the drift pass, so it lands
 * on the first observing pass past the window — at least this long after
 * `LIVE`, and up to one {@link DEFAULT_DRIFT_INTERVAL_MS} later.
 * ponytail: a soak that must land closer to the window needs the pass to pull
 * the next observation forward to the earliest open window, which is one more
 * select per pass; add it if the drift interval ever stops being acceptable.
 */
export const DEPLOY_SOAK_MS = 2 * 60_000;

/**
 * The interval to wait before looking for work again.
 *
 * Fast while something is unsettled, and only a little slower when nothing is:
 * both ends of this are the latency a developer feels between pressing a button
 * and something happening.
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

    // Only a fresh `PENDING` intent is a "pickup" in the sense a developer
    // feels — a reclaimed stale `APPLYING`/`WAITING` lease is a retry, and
    // timing it against the original Deploy would report the crashed
    // reconciler's downtime as latency this one caused.
    if (row.deploy.phase === 'PENDING') {
      reconcilerPickupLatency.record(
        (now.getTime() - row.deploy.createdAt.getTime()) / 1000,
        { kind: 'deploy' },
      );
    }

    // The claim mints the attempt's identity in the same statement that takes
    // the row — the lock dies with this transaction, so this column is what is
    // left to tell the holder from a predecessor whose lease was reclaimed
    // under it. `builds.dispatch_id` is the same idiom on the build side.
    const attemptId = crypto.randomUUID();
    await tx
      .update(deploys)
      .set({ phase: 'APPLYING', updatedAt: now, attemptId })
      .where(eq(deploys.id, row.deploy.id));

    return {
      ...row.deploy,
      phase: 'APPLYING' as const,
      updatedAt: now,
      attemptId,
    };
  });
}

/** Everything one attempt needs, read once. */
interface AttemptSubject {
  readonly deploy: Deploy;
  readonly app: typeof apps.$inferSelect;
  readonly component: typeof components.$inferSelect;
  readonly build: typeof builds.$inferSelect;
  readonly target: TargetWithConnection<typeof targets.$inferSelect>;
  /** The boundary the Target is a surface on — half of what the adapter gets. */
  readonly vessel: typeof vessels.$inferSelect & VesselRef;
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
  const { deploy, app, build, target } = subject;
  return {
    // The row's own key, which is why it is not in the pinned document.
    deploy: String(deploy.id),
    // Everything this intent asked for, exactly as it asked for it. Nothing
    // here re-reads `components`: an attempt that did would deliver a shape
    // nobody asked for, and a rollback would come back up with yesterday's
    // artifact under today's kind, exposure and schedule.
    ...deploy.desired,
    // Carried by the Build, which is immutable once `SUCCEEDED` — and a Deploy
    // cannot be written naming one that is not (`checkDeployable`).
    artifact: {
      type: build.artifactType,
      digest: build.artifactDigest ?? '',
      refs: build.artifactRefs ?? [],
    },
    // Derived, not pinned: a name is a property of the App rather than of a
    // release. §9 makes moving an App between backends "one record re-point",
    // which only holds if the name outlives the releases under it — so a
    // rollback must not take back the address somebody bookmarked.
    hostname: hostnameFor({
      app: app.name,
      component: deploy.desired.component,
      adapter: target.adapter,
      reach: deploy.desired.reach,
      zones: manifest.dns.zones,
      zone: app.zone,
      vanityLabel: vanityIsUnambiguous ? app.vanityDomain : null,
    }),
  };
}

/** What one attempt did. */
export interface AttemptOutcome {
  readonly deployId: number;
  /**
   * `LOST` is not a phase the row ever carries: it is this attempt saying the
   * verdict it arrived at was not its to write, because the claim it started
   * under had already been reclaimed. Reported rather than swallowed so a
   * rollout that produces losers is visible — a loser is the fence working, not
   * an error, which is why it settles nothing and pages nobody.
   */
  readonly phase: 'LIVE' | 'FAILED' | 'LOST';
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
 *
 * **The claim is carried, not assumed.** A heartbeat keeps
 * {@link deploys.updatedAt} moving so a long apply does not self-qualify for
 * reclaim, and every write below is fenced on the attempt id the claim minted.
 * The moment a heartbeat matches no row this attempt has been superseded, so it
 * abandons the stream rather than finishing an apply somebody else is already
 * redoing.
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
  const attemptId = deploy.attemptId;
  const desired = desiredStateFor(
    subject,
    context.manifest,
    await soleServingComponent(context, subject),
  );
  const targetRef = deployTargetOf(subject.target, subject.vessel);

  let lost = false;
  let cancelledBy: string | null = null;
  const refreshUntil = context.clock.now().getTime() + DEPLOY_ATTEMPT_MAX_MS;
  const heartbeat = setInterval(() => {
    // The tick has two jobs and the cap ends only one of them. Refreshing
    // `updated_at` is what keeps a slow-but-healthy apply out of the reclaim,
    // and past the cap that stops: a heartbeat which outlived every deadline is
    // a hang, and renewing it forever would make the stall permanent instead of
    // self-healing. Asking whether the row is still ours does *not* stop, and
    // the ticks past the cap are the only ones that can ever answer no — a
    // reclaim needs DEFAULT_CLAIM_TIMEOUT_MS of silence, so it cannot happen
    // until long after the last refresh. Ending the timer at the cap left this
    // attempt streaming into a log somebody else now owns for the rest of its
    // life; keeping it alive read-only is how `lost` gets to fire.
    const refreshLease = context.clock.now().getTime() < refreshUntil;
    void heartbeatAttempt(context, deploy.id, attemptId, refreshLease).then(
      (held) => {
        if (!held) lost = true;
      },
      // A database that refused this one write is not the same fact as a lease
      // somebody else holds, and the next tick asks again.
      () => {},
    );
    // The same tick is where a cancel request reaches an attempt whose adapter
    // is silent — a sequential upload or one hung call yields nothing for the
    // reader below to notice it on.
    void cancelRequestOn(context, deploy.id, attemptId).then(
      (by) => {
        if (by !== null) cancelledBy = by;
      },
      () => {},
    );
  }, DEPLOY_HEARTBEAT_MS);

  let verdict: DeployVerdict;
  try {
    const stream = subject.adapter.apply(targetRef, desired);
    let next = await stream.next();
    while (!next.done) {
      if (lost) {
        // `return` rather than dropping the generator on the floor: it runs the
        // adapter's own `finally` blocks, and the verdict handed in is the
        // value the generator returns to nobody — this attempt has already lost
        // the right to write one.
        await stream.return({
          phase: 'FAILED',
          reason: 'INTERNAL',
          detail: RECLAIMED_SENTENCE,
        });
        return abandon(context, attempt);
      }
      // Asked again per event, not only per heartbeat tick: a chatty adapter
      // is cancelled at its next event rather than up to a minute later. Like
      // the reclaim above, this can only act between events — an adapter that
      // never yields is ended by the lease cap, not by a cancel.
      cancelledBy ??= await cancelRequestOn(context, deploy.id, attemptId);
      if (cancelledBy !== null) {
        // The same tear-down the reclaim takes, and it is the only one core
        // has: the adapter's `finally` blocks run, and what the platform does
        // next is the platform's. `kubernetes` and `cloudrun` apply under the
        // Component's own name, so the next intent converges over whatever
        // this one left. `vercel` and `cloudflare-pages` mint a deployment per
        // create with nothing to converge on (contract.ts, `apply`): a cancel
        // there stops Spindrift watching, and the platform may still finish
        // the deployment on its own.
        await stream.return({
          phase: 'FAILED',
          reason: 'INTERNAL',
          detail: cancelledSentence(cancelledBy),
        });
        return settleCancelled(context, subject, cancelledBy);
      }
      await absorb(context, attempt, deploy.id, attemptId, next.value);
      next = await stream.next();
    }
    verdict = next.value;
  } catch (cause) {
    verdict = {
      phase: 'FAILED',
      reason: 'INTERNAL',
      detail: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    clearInterval(heartbeat);
  }

  return settle(context, subject, desired, verdict);
}

/** What the attempt log says when a reclaim, not a platform, ended an attempt. */
const RECLAIMED_SENTENCE =
  'this attempt lost its claim to another reconciler and wrote nothing; ' +
  'the attempt that holds the claim reports what happened';

/**
 * Say on the attempt log that this attempt is not the one settling the row.
 *
 * Said rather than swallowed: an attempt that stopped mid-apply and left no
 * line reads, from the log, as a rollout that simply stopped — and the whole
 * value of the fence is that the silence it prevents is a wrong verdict.
 */
async function abandon(
  context: DeployLoopContext,
  attempt: { appId: string; componentId: string; deployId: number },
): Promise<AttemptOutcome> {
  await recordDeployEvent(context.db, attempt, {
    type: 'log',
    line: RECLAIMED_SENTENCE,
  });
  return { deployId: attempt.deployId, phase: 'LOST', url: null };
}

/** The one sentence a cancelled Deploy carries, on the row and on the log. */
function cancelledSentence(by: string): string {
  return `cancelled by ${by}`;
}

/**
 * Who asked this attempt to stop, or `null` while nobody has.
 *
 * Read through the same fence every other read of the row takes: a request
 * stamped on a row this attempt no longer holds is the reclaiming attempt's to
 * honour, and answering it here would have two attempts tearing down one apply.
 */
async function cancelRequestOn(
  context: DeployLoopContext,
  deployId: number,
  attemptId: string | null,
): Promise<string | null> {
  const [row] = await context.db
    .select({ by: deploys.cancelRequestedBy })
    .from(deploys)
    .where(
      and(fencedOn(deployId, attemptId), isNotNull(deploys.cancelRequestedAt)),
    );
  return row?.by ?? null;
}

/**
 * Settle a cancelled attempt: `FAILED`, with who asked and nothing else.
 *
 * No `reason`, for the reason `cancelBuild` gives none: §6's closed set
 * indicts a developer or the platform, and a cancellation indicts neither — so
 * nothing derives a blame from it either. The detail carries the sentence and
 * the log carries it again, which is where a reader looking for "why did this
 * stop" already looks. Fenced like every other settle, so an attempt whose
 * lease was reclaimed while it was being cancelled abandons instead of writing
 * a verdict over the holder's.
 */
async function settleCancelled(
  context: DeployLoopContext,
  subject: AttemptSubject,
  by: string,
): Promise<AttemptOutcome> {
  const deployId = subject.deploy.id;
  const attempt = {
    appId: subject.app.id,
    componentId: subject.component.id,
    deployId,
  };
  const settled = await context.db
    .update(deploys)
    .set({
      phase: 'FAILED',
      reason: null,
      blame: null,
      detail: cancelledSentence(by),
      debug: null,
      updatedAt: context.clock.now(),
    })
    .where(fencedOn(deployId, subject.deploy.attemptId))
    .returning({ id: deploys.id });
  if (settled.length === 0) return abandon(context, attempt);

  await recordDeployEvent(context.db, attempt, {
    type: 'log',
    line: cancelledSentence(by),
  });
  await recordDeployEvent(context.db, attempt, {
    type: 'status',
    phase: 'FAILED',
  });
  return { deployId, phase: 'FAILED', url: null };
}

/**
 * Report whether the attempt still holds the claim, optionally saying so first.
 *
 * Exported apart from the timer that calls it so the part with a decision in it
 * is testable under an injected clock, while the untestable `setInterval` stays
 * the two lines around it. `false` means the row has moved on — either its
 * `attempt_id` is somebody else's now, or the Deploy is gone.
 *
 * `refreshLease` is the half {@link DEPLOY_ATTEMPT_MAX_MS} takes away. Read-only
 * it answers the same question without renewing a lease the cap has decided
 * should expire, which is what lets an attempt past the cap still find out it
 * was reclaimed.
 */
export async function heartbeatAttempt(
  context: DeployLoopContext,
  deployId: number,
  attemptId: string | null,
  refreshLease = true,
): Promise<boolean> {
  if (attemptId === null) return false;
  const mine = fencedOn(deployId, attemptId);
  const held = refreshLease
    ? await context.db
        .update(deploys)
        .set({ updatedAt: context.clock.now() })
        .where(mine)
        .returning({ id: deploys.id })
    : await context.db.select({ id: deploys.id }).from(deploys).where(mine);
  return held.length > 0;
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

  const serving = siblings.filter(servesNetwork);
  return serving.length === 1 && serving[0]?.id === subject.component.id;
}

/** Write one adapter event to the log, and its phase to the row. */
async function absorb(
  context: DeployLoopContext,
  attempt: { appId: string; componentId: string; deployId: number },
  deployId: number,
  attemptId: string | null,
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
      .where(fencedOn(deployId, attemptId));
  }
}

/**
 * The row, and only while this attempt still holds it.
 *
 * Every write an attempt makes to its own Deploy row goes through this. Zero
 * rows matched **is** the refusal — the same discipline `deployApp`'s re-arm
 * takes against a live build lease, and the same shape `dispatch.ts` already
 * releases a claim under. A caller with no attempt id holds nothing, and the
 * empty string it falls back to is a value no claim ever mints — so it matches
 * no row, which is the right answer rather than an accident of SQL's `= NULL`.
 */
function fencedOn(deployId: number, attemptId: string | null) {
  return and(eq(deploys.id, deployId), eq(deploys.attemptId, attemptId ?? ''));
}

/**
 * Persist the terminal verdict, and the diagnosis if there is one.
 *
 * Both writes are fenced on the attempt id the claim minted ({@link fencedOn}),
 * and matching zero rows ends the attempt in {@link abandon} instead of in a
 * verdict. This is the write the whole fence exists for: an attempt whose lease
 * was reclaimed mid-apply used to arrive here minutes after another reconciler
 * had already placed the same workload, and write `LIVE` over its `FAILED`.
 */
async function settle(
  context: DeployLoopContext,
  subject: AttemptSubject,
  desired: DesiredState,
  verdict: DeployVerdict,
): Promise<AttemptOutcome> {
  const now = context.clock.now();
  const deployId = subject.deploy.id;
  const mine = fencedOn(deployId, subject.deploy.attemptId);
  const attempt = {
    appId: subject.app.id,
    componentId: subject.component.id,
    deployId,
  };

  if (verdict.phase === 'LIVE') {
    // §9: where the platform names its own, the canonical comes back across the
    // seam. Where core minted one, the adapter has nothing to add and core's
    // name stands.
    const canonicalUrl =
      verdict.url ?? displayUrl({ canonical: desired.hostname.canonical });

    // And the vanity is the name §9 says a developer shares, so it is the one
    // every screen reading this row prints — the App list, the workspace
    // headline, a Deploy's own page. The canonical stays underneath it and is
    // what the row falls back to.
    //
    // Only where this deploy is what publishes the name, which is the same
    // condition `publishVanityRecord` below applies: a cluster renders the
    // vanity into its own release (`values.ts` hands the chart both names), and
    // a platform-named Target needs an `address` for a record to point at —
    // one that reports none (§6's contract: Firebase Hosting, Cloud Run) leaves
    // the name unpointed, and the attempt log says to point it by hand. Naming
    // it as this release's address there would put a name nothing serves on the
    // row an operator scans for what is up.
    const publishesVanity =
      coreMintsCanonical(subject.target.adapter) ||
      verdict.address !== undefined;
    const url =
      (publishesVanity ? displayUrl(desired.hostname) : null) ?? canonicalUrl;

    const settled = await context.db
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
      .where(mine)
      .returning({ id: deploys.id });
    if (settled.length === 0) return abandon(context, attempt);

    await recordDeployEvent(context.db, attempt, {
      type: 'status',
      phase: 'LIVE',
    });

    // §9: a cluster Target already publishes its own record as part of the
    // release the App chart renders — the only Targets left owing one are the
    // platform-named ones, exactly `!coreMintsCanonical`.
    if (!coreMintsCanonical(subject.target.adapter)) {
      await publishVanityRecord(context, attempt, desired, verdict);
    }

    return { deployId, phase: 'LIVE', url };
  }

  const diagnosis = diagnosisOf(verdict);
  // §12: the platform will not keep this. Cluster events expire in about an
  // hour, so what is written here is the only copy that will exist tomorrow.
  const settled = await context.db
    .update(deploys)
    .set({
      ...failureColumns(diagnosis!),
      ...(verdict.ref === undefined ? {} : { ref: verdict.ref }),
      updatedAt: now,
    })
    .where(mine)
    .returning({ id: deploys.id });
  if (settled.length === 0) return abandon(context, attempt);

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

/**
 * Converge or withdraw the vanity record a platform-named Target's LIVE
 * verdict earns (§9).
 *
 * **Never turns a LIVE deploy FAILED.** The workload is up — a DNS write that
 * fails is a fact for the attempt log, the way every other non-terminal event
 * `absorb` writes is, not a reason to tell the operator their deploy did not
 * work.
 */
async function publishVanityRecord(
  context: DeployLoopContext,
  attempt: { appId: string; componentId: string; deployId: number },
  desired: DesiredState,
  verdict: Extract<DeployVerdict, { phase: 'LIVE' }>,
): Promise<void> {
  const dns = context.adapters.dns?.() ?? null;
  if (dns === null) {
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line:
        'this installation has no DNS publisher configured, so no vanity ' +
        'record was published',
    });
    return;
  }

  const handle = dnsHandleFor(desired.app, desired.component);

  // A cleared or newly ambiguous vanity (`soleServingComponent`) takes its
  // record with it. Idempotent when nothing was ever published under this
  // handle — the ordinary case for every Component that never had one.
  if (desired.hostname.vanity === undefined) {
    try {
      await dns.withdraw(handle);
      // Said rather than done in silence. This removes the record Spindrift
      // *states*; whether the record itself goes depends on external-dns
      // owning it, and it never owns one at a zone apex (`isApexName`). An App
      // that was on a bare domain leaves that name resolving to wherever it
      // last pointed, and a silent success read as though it had not.
      await recordDeployEvent(context.db, attempt, {
        type: 'log',
        line:
          `stopped stating a DNS record for ${handle}. If this App answered ` +
          'on a bare domain, that record is not withdrawn by this — remove it ' +
          'in your DNS provider.',
      });
    } catch (cause) {
      await recordDeployEvent(context.db, attempt, {
        type: 'log',
        line: `withdrawing the DNS record for ${handle} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    return;
  }

  if (verdict.address === undefined) {
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line:
        `this Target publishes no record for ${desired.hostname.vanity} — ` +
        `point it at ${verdict.url ?? 'this Target’s own address'} by hand`,
    });
    return;
  }

  try {
    await dns.publish(handle, {
      dnsName: desired.hostname.vanity,
      recordType: verdict.address.recordType,
      target: verdict.address.target,
      proxied: verdict.address.proxied,
    });
    // An apex is create-once, so "published" is only true the first time. On
    // every deploy after it, external-dns has no ownership marker for the name
    // and drops the update — the record keeps pointing wherever it first went.
    // Reporting a re-point that did not happen is the whole of what makes this
    // dangerous, since every other surface says the deploy worked.
    const apex = isApexName(
      desired.hostname.vanity,
      context.manifest.dns.zones,
    );
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line: apex
        ? `stated ${desired.hostname.vanity} -> ${verdict.address.target}. A ` +
          'bare domain is published once and never re-pointed or removed ' +
          'after that: if this name already answered somewhere else, change ' +
          'it in your DNS provider.'
        : `published ${desired.hostname.vanity} -> ${verdict.address.target}`,
    });
  } catch (cause) {
    await recordDeployEvent(context.db, attempt, {
      type: 'log',
      line: `publishing the DNS record for ${desired.hostname.vanity} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
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

  // One adapter round trip each, and they do not depend on one another — so
  // the pass costs the slowest Target rather than the sum of every Target.
  // ponytail: unbounded fan-out, add a concurrency cap if an installation ever
  // carries enough live releases to make that a thundering herd.
  const reports = (
    await Promise.all(live.map((deploy) => observeOne(context, deploy, now)))
  ).filter((report): report is DriftReport => report !== null);
  return reports;
}

/** Read one converged release back off its platform, and say what it found. */
async function observeOne(
  context: DeployLoopContext,
  deploy: Deploy,
  now: Date,
): Promise<DriftReport | null> {
  if (deploy.ref === null || deploy.orphanedAt !== null) return null;
  const subject = await subjectOf(context, deploy);
  if (subject === null) return null;

  let state: ObservedState | null = null;
  try {
    state = await subject.adapter.observe(
      deployTargetOf(subject.target, subject.vessel),
      deploy.ref,
    );
  } catch {
    // A Target that cannot be reached is not a Target that has drifted. Saying
    // "drifted" here would turn every uplink blip into a false alarm about
    // something a developer did.
    return null;
  }
  const observed = state?.artifactDigest ?? null;

  // The soak, judged off the read this pass already paid for. Measured from
  // the row's last write, which for a release that just landed is the `LIVE`
  // verdict; the drift write below can move it, so a finding inside the
  // window errs toward judging later, never sooner. Before that write, so
  // this pass judges against the window as it stood when the pass began.
  if (
    deploy.soakedAt === null &&
    deploy.faultyAt === null &&
    now.getTime() >= deploy.updatedAt.getTime() + DEPLOY_SOAK_MS
  ) {
    await judgeSoak(context, subject, state, now);
  }

  // The cadence half of the same comparison, where the backend reports one.
  // Read off the Component rather than the Deploy: `schedule` is what the
  // developer declares now, and a cadence they changed since this Deploy is a
  // difference the platform is meant to be asked to converge on, not one this
  // pass should paper over.
  const scheduleArgs = {
    desiredSchedule: subject.component.schedule,
    ...(state?.schedule === undefined
      ? {}
      : { observedSchedule: state.schedule }),
  };
  const drifted = hasDrifted({
    phase: deploy.phase,
    desiredDigest: subject.build.artifactDigest ?? '',
    observedDigest: observed,
    ...scheduleArgs,
    ...(state === null ? {} : { observedPhase: state.phase }),
  });

  // The platform's own sentence, kept only while it is the reason. §12's
  // argument for storing a diagnosis applies here for the same cause: a
  // Helm error naming the value that no longer renders is not recoverable
  // from anywhere once the object is reconciled again.
  //
  // A stopped schedule gets core's sentence rather than the platform's,
  // because the platform said nothing — the finding *is* the absence, and
  // "nothing fires this any more" is only a sentence somebody holding the
  // declaration can write.
  const driftDetail = !drifted
    ? null
    : state?.phase === 'FAILED'
      ? (state.detail ?? null)
      : scheduleDrift(scheduleArgs);

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

  return {
    deployId: deploy.id,
    drifted,
    observedDigest: observed,
    driftDetail,
  };
}

/** Core's sentence for a faulty release whose platform gave none. */
const FAULTY_SENTENCE =
  'the platform reports this release failed after it had passed readiness';

/**
 * Judge one release's soak off the observation the drift pass already took.
 *
 * The platform reporting `FAILED` on the object that still carries this
 * release's digest is the whole test. A digest that has moved on belongs to a
 * newer release, which is judged on its own row; nothing there, or a platform
 * that says it is fine, closes the window with `soakedAt`. Either stamp is
 * written once and never revisited, so a release that goes bad an hour later
 * is drift (information, §6) rather than a fault with a blame.
 *
 * The verdict is written the way `settle` writes a red one — `diagnosisOf`
 * derives the blame, the observation is the `debug` payload — but the phase
 * stays `LIVE`: the rollout landed, and the desired pointer still names this
 * release. Said on the attempt log too, so the timeline carries it.
 */
async function judgeSoak(
  context: DeployLoopContext,
  subject: AttemptSubject,
  state: ObservedState | null,
  now: Date,
): Promise<void> {
  const { deploy } = subject;
  if (
    state === null ||
    state.phase !== 'FAILED' ||
    state.artifactDigest !== (subject.build.artifactDigest ?? '')
  ) {
    await context.db
      .update(deploys)
      .set({ soakedAt: now })
      .where(eq(deploys.id, deploy.id));
    return;
  }

  // `UNHEALTHY` where the platform names no reason: what is known is that
  // readiness held and then did not, and that is the row of §6's table it
  // lands on.
  const diagnosis = diagnosisOf({
    phase: 'FAILED',
    reason: state.reason ?? 'UNHEALTHY',
    detail: state.detail ?? FAULTY_SENTENCE,
    debug: state,
  })!;
  await context.db
    .update(deploys)
    .set({
      reason: diagnosis.reason,
      blame: diagnosis.blame,
      detail: diagnosis.detail,
      debug: diagnosis.debug,
      faultyAt: now,
      updatedAt: now,
    })
    .where(eq(deploys.id, deploy.id));

  const attempt = {
    appId: subject.app.id,
    componentId: subject.component.id,
    deployId: deploy.id,
  };
  await recordDeployEvent(context.db, attempt, {
    type: 'log',
    line: `faulty after readiness: ${diagnosis.detail}`,
  });
  await recordDeployEvent(context.db, attempt, {
    type: 'status',
    phase: 'FAULTY',
    reason: diagnosis.reason,
  });
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
      vessel: vessels,
    })
    .from(deploys)
    .innerJoin(components, eq(deploys.componentId, components.id))
    .innerJoin(apps, eq(components.appId, apps.id))
    .innerJoin(builds, eq(deploys.buildId, builds.id))
    .innerJoin(targets, eq(deploys.targetId, targets.id))
    // Inner, not left: `vesselId` is NOT NULL, so a Target with no vessel is
    // not a state that exists — and joining it here is what lets one read
    // assemble everything the adapter is handed.
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(deploys.id, deploy.id));

  if (row === undefined) return null;
  const target = row.target;
  const vessel = row.vessel;
  // Addressable means both halves: the surface's own facts and the boundary's
  // location. They are written by one act, so disagreeing is not a state that
  // occurs — but nothing enforces that, so it is checked rather than assumed.
  if (!hasTargetConnection(target) || !hasVesselLocation(vessel)) return null;

  const adapter = context.adapters.deploy(target.adapter);
  if (adapter === null) return null;

  return {
    deploy,
    ...row,
    target,
    vessel,
    adapter,
  };
}

/** How the loop runs, and how to stop it. */
export interface DeployLoopOptions {
  readonly intervals?: LoopIntervals;
  /** Overrides {@link DEFAULT_DRIFT_INTERVAL_MS}, for a test that cannot wait. */
  readonly driftIntervalMs?: number;
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

/** What one pass is asked to do beyond claiming work. */
export interface DeployPassOptions {
  /**
   * Whether to re-read converged releases for drift.
   *
   * The loop passes `false` on most ticks, because looking for work and looking
   * for drift are different costs on different clocks
   * ({@link DEFAULT_DRIFT_INTERVAL_MS}). Defaults to `true`, so a caller that
   * wants one complete pass gets one.
   */
  readonly observe?: boolean;
}

/**
 * Claim every eligible intent, run them all, then optionally look for drift.
 *
 * **Claim in rounds, run each round together.** Claiming is a short transaction
 * and applying is somebody else's control plane taking minutes, so the two are
 * not interleaved: everything claimable is marked `APPLYING` up front and those
 * attempts then run concurrently. Applying them one after another made a second
 * App's deploy wait out the first App's whole rollout — two unrelated workloads,
 * on two unrelated Targets, serialised by nothing but the shape of a `for` loop.
 *
 * Concurrency within a round is safe by the same rule that makes claiming safe:
 * `claimNextDeploy` refuses a Component@Target that already has an in-flight
 * Deploy, so a round holds at most one attempt per workload and no two attempts
 * are ever placing the same thing.
 *
 * That refusal is also why the rounds repeat. Two queued intents for **one**
 * Component@Target must still land in order, and the second only becomes
 * claimable once the first is settled — so the pass keeps claiming until a round
 * comes back empty. The wall clock is the deepest single queue rather than the
 * sum of everything pending.
 */
export async function runDeployPass(
  context: DeployLoopContext,
  options: DeployPassOptions = {},
): Promise<LoopPass> {
  const applied: AttemptOutcome[] = [];
  for (;;) {
    const claimed: Deploy[] = [];
    for (;;) {
      const next = await claimNextDeploy(context);
      if (next === null) break;
      claimed.push(next);
    }
    if (claimed.length === 0) break;
    // ponytail: unbounded fan-out, bounded in practice by how many distinct
    // Component@Targets are pending at once. Add a pool if that stops holding.
    const outcomes = await Promise.all(
      claimed.map(async (deploy) => {
        // `runAttempt` runs the adapter's whole apply stream to a terminal
        // verdict before returning, so this is the deploy's real duration —
        // not the loop's own bookkeeping around it.
        const startedAt = Date.now();
        const outcome = await runAttempt(context, deploy);
        reconcilerAttemptDuration.record((Date.now() - startedAt) / 1000, {
          kind: 'deploy',
          outcome: outcome?.phase ?? 'skipped',
        });
        return outcome;
      }),
    );
    for (const outcome of outcomes) {
      if (outcome !== null) applied.push(outcome);
    }
  }

  // `null` rather than `[]` when skipped, so a fast tick that does not
  // observe cannot be mistaken for one that observed zero drifted releases —
  // §6 wants drift reported on its own slow clock, and recording a false zero
  // between drift-observing passes would erase the last real count from
  // anyone scraping between them.
  const driftReports =
    options.observe === false ? null : await observeConverged(context);
  if (driftReports !== null) {
    reconcilerDriftedDeploys.record(
      driftReports.filter((report) => report.drifted).length,
    );
  }

  const unsettled = await unsettledPhases(context);
  reconcilerQueueDepth.record(unsettled.length, { kind: 'deploy' });

  return {
    applied,
    drift: driftReports ?? [],
    unsettled,
  };
}

/** Run until aborted. */
export async function runDeployLoop(
  context: DeployLoopContext,
  options: DeployLoopOptions = {},
): Promise<void> {
  const intervals = options.intervals ?? DEFAULT_INTERVALS;
  const driftMs = options.driftIntervalMs ?? DEFAULT_DRIFT_INTERVAL_MS;
  // Zero, so the first pass observes: a reconciler that just started has no
  // idea what the platforms are holding, and that is the moment to find out.
  let nextDriftAt = 0;

  while (!options.signal?.aborted) {
    const startedAt = context.clock.now().getTime();
    const observe = startedAt >= nextDriftAt;
    if (observe) nextDriftAt = startedAt + driftMs;

    // Wall-clock, not `context.clock` — this measures how long the pass
    // actually took to run, which is a fact about the machine rather than
    // about the domain time the injected clock stands in for during tests.
    const passWallStartedAt = Date.now();
    const pass = await runDeployPass(context, { observe });
    reconcilerLoopDuration.record((Date.now() - passWallStartedAt) / 1000, {
      loop: 'deploy',
    });
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
