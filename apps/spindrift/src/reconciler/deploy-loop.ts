/**
 * Claims Deploy intents, runs each through its adapter to a verdict, and reads
 * converged releases back for drift and soak. It polls; an optional `wakeup`
 * can only shorten a sleep.
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
import {
  blameFor,
  type DeployAdapter,
  type DeployEvent,
  type DeployPhase,
  type DeployVerdict,
  type ObservedState,
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
  installationHostnames,
  isApexName,
  ownHostnameMintedIn,
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

export interface DeployLoopContext {
  readonly db: Database;
  /** `dns` publishes vanity records for platform-named Targets. */
  readonly adapters: Pick<AdapterRegistry, 'deploy' | 'dns'>;
  readonly clock: Clock;
  readonly manifest: InstallationManifest;
}

// `PENDING` is a developer waiting. `APPLYING` and `WAITING` outlive a pass
// only when a reconciler died mid-attempt.
const UNSETTLED: readonly DeployPhase[] = ['PENDING', 'APPLYING', 'WAITING'];
const IN_FLIGHT: readonly DeployPhase[] = ['APPLYING', 'WAITING'];

/** An in-flight phase untouched for this long is reclaimable. */
export const DEFAULT_CLAIM_TIMEOUT_MS = 15 * 60_000;

// Keeps `updated_at` moving while an adapter emits only logs, which write no
// row, so a slow but healthy apply is not reclaimed.
export const DEPLOY_HEARTBEAT_MS = 60_000;

// Three times the adapters' ten-minute convergence deadline. Past it the lease
// stops renewing, so a hung call is reclaimed; `attempt_id` fences its writes.
export const DEPLOY_ATTEMPT_MAX_MS = 30 * 60_000;

export interface LoopIntervals {
  /** While anything is unsettled. */
  readonly fastMs: number;
  /** Otherwise. Still seconds, because this is time to pickup. */
  readonly slowMs: number;
}

export const DEFAULT_INTERVALS: LoopIntervals = {
  fastMs: 1_000,
  slowMs: 2_000,
};

// Minutes: a drift pass costs one adapter round trip per live release.
export const DEFAULT_DRIFT_INTERVAL_MS = 5 * 60_000;

// The first drift pass at least this long after `LIVE` judges the soak, so the
// judgement can arrive up to one drift interval late.
// ponytail: pull the next observation forward to the earliest open window, at
// one more select per pass, if that lateness ever matters.
export const DEPLOY_SOAK_MS = 2 * 60_000;

export function intervalFor(
  phases: readonly DeployPhase[],
  intervals: LoopIntervals = DEFAULT_INTERVALS,
): number {
  return phases.some((phase) => UNSETTLED.includes(phase))
    ? intervals.fastMs
    : intervals.slowMs;
}

/**
 * Read after each pass: a pass returns only terminal outcomes, and an intent
 * may have arrived while it ran.
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
 * The row lock lasts only until `APPLYING` is written. The phase is then a
 * lease that blocks the pair until it goes stale, and a stale one is retried.
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
          // A recent in-flight Deploy owns this Component@Target.
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
      // Oldest first, so intents for one Component@Target apply in order.
      .orderBy(asc(deploys.id))
      .limit(1)
      // Locks the pair's desired row, so a replica skips the whole pair and
      // never claims a newer intent for the same workload.
      .for('update', { of: componentTargetDesired, skipLocked: true });

    if (row === undefined) return null;

    // Only a fresh `PENDING` counts as pickup; a reclaimed lease is a retry.
    if (row.deploy.phase === 'PENDING') {
      reconcilerPickupLatency.record(
        (now.getTime() - row.deploy.createdAt.getTime()) / 1000,
        { kind: 'deploy' },
      );
    }

    // The lock ends with this transaction; the attempt id then tells the holder
    // from a predecessor whose lease was reclaimed.
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

interface AttemptSubject {
  readonly deploy: Deploy;
  readonly app: typeof apps.$inferSelect;
  readonly component: typeof components.$inferSelect;
  readonly build: typeof builds.$inferSelect;
  readonly target: TargetWithConnection<typeof targets.$inferSelect>;
  readonly vessel: typeof vessels.$inferSelect & VesselRef;
  readonly adapter: DeployAdapter;
}

/** Backend-neutral: every adapter renders its own resources from this. */
export function desiredStateFor(
  subject: AttemptSubject,
  manifest: InstallationManifest,
  /**
   * The App's vanity name goes only to its sole network-serving Component: two
   * claimants would put one hostname on two routes.
   */
  vanityIsUnambiguous: boolean,
): DesiredState {
  const { deploy, app, build, target } = subject;
  return {
    deploy: String(deploy.id),
    // What this intent pinned, never re-read from `components`, so an edit
    // made after the intent cannot change what it places.
    ...deploy.desired,
    // Immutable: `checkDeployable` admits only a `SUCCEEDED` Build.
    artifact: {
      type: build.artifactType,
      digest: build.artifactDigest ?? '',
      refs: build.artifactRefs ?? [],
    },
    // Derived from the App, so a rollback never takes back a bookmarked name.
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

export interface AttemptOutcome {
  readonly deployId: number;
  /** `LOST`: the claim was reclaimed, so this attempt wrote no verdict. */
  readonly phase: 'LIVE' | 'FAILED' | 'LOST';
  readonly url: string | null;
}

/**
 * Phases come only from the adapter, and a throw becomes an `INTERNAL` verdict.
 * Every write is fenced on the claim's attempt id; a lost lease abandons.
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

  // The reservation `setAppVanity` enforces, for names it never checks:
  // canonical names, and vanity labels stored without that check.
  const shadowed = ownHostnameMintedIn(
    desired.hostname,
    installationHostnames(context.manifest.controlPlane),
  );
  if (shadowed !== null) {
    return settle(context, subject, desired, {
      phase: 'FAILED',
      reason: 'REJECTED',
      detail: `${shadowed} is reserved by this installation, so no App is served on it — rename the Component or change the App's vanity name`,
    });
  }

  let lost = false;
  let cancelledBy: string | null = null;
  const refreshUntil = context.clock.now().getTime() + DEPLOY_ATTEMPT_MAX_MS;
  const heartbeat = setInterval(() => {
    // Past the cap the lease stops renewing, but the ownership check goes on:
    // only those later ticks can see a reclaim and set `lost`.
    const refreshLease = context.clock.now().getTime() < refreshUntil;
    void heartbeatAttempt(context, deploy.id, attemptId, refreshLease).then(
      (held) => {
        if (!held) lost = true;
      },
      // A failed write is not a lost lease; the next tick asks again.
      () => {},
    );
  }, DEPLOY_HEARTBEAT_MS);

  let verdict: DeployVerdict;
  try {
    const stream = subject.adapter.apply(targetRef, desired);
    let next = await stream.next();
    while (!next.done) {
      if (lost) {
        // `return` runs the adapter's `finally` blocks; its verdict is unused.
        await stream.return({
          phase: 'FAILED',
          reason: 'INTERNAL',
          detail: RECLAIMED_SENTENCE,
        });
        return abandon(context, attempt);
      }
      // Checked per event: `stream.return` cannot interrupt a pending `next()`,
      // so an adapter that never yields is ended only by the lease cap.
      cancelledBy ??= await cancelRequestOn(context, deploy.id, attemptId);
      if (cancelledBy !== null) {
        // The reclaim's tear-down. An adapter that mints a deployment per
        // create stops watching it, and the platform may still finish it.
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

const RECLAIMED_SENTENCE =
  'this attempt lost its claim to another reconciler and wrote nothing; ' +
  'the attempt that holds the claim reports what happened';

/** Logged, so a fenced-out attempt does not read as a rollout that stopped. */
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

function cancelledSentence(by: string): string {
  return `cancelled by ${by}`;
}

/**
 * Who asked this attempt to stop, or `null`. Fenced: a request on a reclaimed
 * row is the new holder's to honour.
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

/** No `reason` or blame: a cancellation indicts neither side. */
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
 * `false` when the Deploy is gone or another attempt holds it. With
 * `refreshLease` off it only checks, for an attempt past the lease cap.
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

  // Only non-terminal phases come from the stream; the terminal one is written
  // once, with the verdict, so the row cannot disagree with it.
  if (event.phase === 'APPLYING' || event.phase === 'WAITING') {
    await context.db
      .update(deploys)
      .set({ phase: event.phase, updatedAt: context.clock.now() })
      .where(fencedOn(deployId, attemptId));
  }
}

/**
 * Every write an attempt makes to its Deploy row goes through this; zero rows
 * matched is the refusal. No claim mints `''`, so a null id matches no row.
 */
function fencedOn(deployId: number, attemptId: string | null) {
  return and(eq(deploys.id, deployId), eq(deploys.attemptId, attemptId ?? ''));
}

/**
 * Fenced ({@link fencedOn}): a reclaimed attempt ends in {@link abandon} and
 * cannot write its verdict over the holder's.
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
    // A platform that names its own address returns it; else core's stands.
    const canonicalUrl =
      verdict.url ?? displayUrl({ canonical: desired.hostname.canonical });

    // Screens print the vanity, but only where this deploy publishes it: a
    // cluster release, or a Target that reported an `address` to point it at.
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
        // A deploy that was just applied is what was asked for. Left
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

    // A cluster release publishes its own record; other Targets need one here.
    if (!coreMintsCanonical(subject.target.adapter)) {
      await publishVanityRecord(context, attempt, desired, verdict);
    }

    return { deployId, phase: 'LIVE', url };
  }

  const diagnosis = diagnosisOf(verdict);
  // Cluster events expire in about an hour, so this is the only lasting copy.
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

  // `exposure` is never touched on red: the previous release is still serving.
  return { deployId, phase: 'FAILED', url: null };
}

/** Never fails a LIVE deploy: a DNS error goes to the attempt log. */
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

  // A cleared or ambiguous vanity withdraws its record; idempotent when none
  // was published.
  if (desired.hostname.vanity === undefined) {
    try {
      await dns.withdraw(handle);
      // External-dns never owns an apex record (`isApexName`), so a bare domain
      // keeps resolving after this.
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
    // An apex is create-once: external-dns has no ownership marker for it and
    // drops every later update.
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

export interface DriftReport {
  readonly deployId: number;
  readonly drifted: boolean;
  readonly observedDigest: string | null;
  /** Why the platform will not converge, when that is the drift. */
  readonly driftDetail: string | null;
}

/**
 * Reports drift and never corrects it: re-converging is a Deploy somebody
 * presses, so a deliberate manual change survives.
 */
export async function observeConverged(
  context: DeployLoopContext,
): Promise<readonly DriftReport[]> {
  const now = context.clock.now();
  // Only the release each pair's desired row names: a superseded row stays LIVE
  // but is not what serves, and would read as drift forever.
  const live = await context.db
    .select({ deploy: deploys })
    .from(componentTargetDesired)
    .innerJoin(deploys, eq(deploys.id, componentTargetDesired.desiredDeployId))
    .where(eq(deploys.phase, 'LIVE'));

  // Concurrent, so the pass costs the slowest Target.
  // ponytail: unbounded fan-out, add a concurrency cap if an installation ever
  // carries enough placements to make that a thundering herd.
  const reports = (
    await Promise.all(
      live.map(({ deploy }) => observeOne(context, deploy, now)),
    )
  ).filter((report): report is DriftReport => report !== null);
  return reports;
}

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
    // An unreachable Target has not drifted.
    return null;
  }
  const observed = state?.artifactDigest ?? null;

  // Measured from the row's last write, the `LIVE` verdict for a fresh release.
  // Judged before the drift write below moves it.
  if (
    deploy.soakedAt === null &&
    deploy.faultyAt === null &&
    now.getTime() >= deploy.updatedAt.getTime() + DEPLOY_SOAK_MS
  ) {
    await judgeSoak(context, subject, state, now);
  }

  // The Component's current schedule, so a cadence changed since this Deploy
  // reads as drift.
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

  // The platform's sentence while it is the reason, since it is gone once the
  // object reconciles. A stopped schedule gets core's; the platform said none.
  const driftDetail = !drifted
    ? null
    : state?.phase === 'FAILED'
      ? (state.detail ?? null)
      : scheduleDrift(scheduleArgs);

  // Stored for the UI, and cleared once the release matches again.
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

const FAULTY_SENTENCE =
  'the platform reports this release failed after it had passed readiness';

/**
 * `FAILED` on the object still carrying this release's digest is faulty, and
 * anything else has soaked. Either stamp is final; the phase stays `LIVE`.
 */
async function judgeSoak(
  context: DeployLoopContext,
  subject: AttemptSubject,
  state: ObservedState | null,
  now: Date,
): Promise<void> {
  const { deploy } = subject;
  // Mid-rollout is neither verdict; the next observing pass judges.
  if (state?.phase === 'APPLYING' || state?.phase === 'WAITING') return;
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

  // Never guessed: every reason but `TIMEOUT` blames somebody.
  const reason = state.reason ?? null;
  const diagnosis = {
    reason,
    blame: reason === null ? null : blameFor(reason),
    detail: state.detail ?? FAULTY_SENTENCE,
    debug: state,
  };
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
    ...(reason === null ? {} : { reason }),
  });
}

/** `null` when the Deploy is not runnable. */
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
    // `vesselId` is NOT NULL, so the inner join drops nothing.
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(deploys.id, deploy.id));

  if (row === undefined) return null;
  const target = row.target;
  const vessel = row.vessel;
  // One act writes both halves, but nothing enforces that.
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

export interface DeployLoopOptions {
  readonly intervals?: LoopIntervals;
  readonly driftIntervalMs?: number;
  readonly signal?: AbortSignal;
  /** An early wake-up, such as `LISTEN`/`NOTIFY`; it only shortens a sleep. */
  readonly wakeup?: (signal: AbortSignal) => Promise<void>;
  readonly onPass?: (pass: LoopPass) => void;
}

export interface LoopPass {
  readonly applied: readonly AttemptOutcome[];
  readonly drift: readonly DriftReport[];
  /** Read from the database after the pass; this sets the next interval. */
  readonly unsettled: readonly DeployPhase[];
}

export interface DeployPassOptions {
  /** The loop passes `false` except on the drift interval. */
  readonly observe?: boolean;
}

/**
 * Claims in rounds and runs each round concurrently, at most one attempt per
 * Component@Target. Rounds repeat so one pair's queued intents apply in order.
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
        // `runAttempt` runs the whole apply, so this is the deploy's duration.
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

  // `null` when skipped, so a tick that did not observe records no false zero.
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

// Polls: a watch across a WAN tunnel can die while still looking connected.
export async function runDeployLoop(
  context: DeployLoopContext,
  options: DeployLoopOptions = {},
): Promise<void> {
  const intervals = options.intervals ?? DEFAULT_INTERVALS;
  const driftMs = options.driftIntervalMs ?? DEFAULT_DRIFT_INTERVAL_MS;
  // Zero, so the first pass observes.
  let nextDriftAt = 0;

  while (!options.signal?.aborted) {
    const startedAt = context.clock.now().getTime();
    const observe = startedAt >= nextDriftAt;
    if (observe) nextDriftAt = startedAt + driftMs;

    // Wall clock: `context.clock` is domain time, which tests inject.
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
    // A rejected wake-up is a dropped notification, which the poll tolerates.
    options.wakeup?.(controller.signal).then(done, () => {});
  });
}
