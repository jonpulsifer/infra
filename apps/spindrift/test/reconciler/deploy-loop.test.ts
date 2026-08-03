/**
 * The deploy loop (Task 20, §6).
 *
 * Four claims, each of which would look fine while being false:
 *
 * - **Every reason arrives with the blame §6's table assigns**, and the blame is
 *   core's derivation rather than the adapter's opinion — so the fake never
 *   supplies one and the row is read back to see what core wrote.
 * - **The diagnosis survives the platform forgetting.** §12 stores it precisely
 *   because cluster events expire in about an hour; the test makes the far side
 *   forget and reads the explanation back anyway.
 * - **Reach never mutates on red** (§9). A failed attempt leaves the App as
 *   reachable as it was, because the previous release is still serving.
 * - **The loop converges with `NOTIFY` dropped.** Notifications are lost when no
 *   listener is connected, so the poll has to be the correctness path. Every
 *   test here runs with no wake-up wired at all.
 */
import { describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import {
  BLAME,
  type DeployVerdict,
  FAILURE_REASONS,
} from '../../src/adapters/deploy/contract.ts';
import type { AdapterRegistry, Clock } from '../../src/commands/types.ts';
import { createDb } from '../../src/db/client.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  claimNextDeploy,
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_INTERVALS,
  type DeployLoopContext,
  intervalFor,
  runAttempt,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  FakeDeployAdapter,
  type ScriptedAttempt,
} from '../harness/fakes/deploy-adapter.ts';
import { fixtureManifest, targetValues } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function context(
  adapter: FakeDeployAdapter,
  overrides: Partial<DeployLoopContext> = {},
): DeployLoopContext {
  const adapters: Pick<AdapterRegistry, 'deploy'> = {
    deploy: (name) => (name === adapter.adapter ? adapter : null),
  };
  return { db: database().db, adapters, clock, manifest, ...overrides };
}

/** An App, Component, Target, Build, and one PENDING Deploy intent. */
async function pendingDeploy(
  options: {
    reach?: 'none' | 'private' | 'public';
    auth?: 'none' | 'proxy';
    /** The backend this lands on, which decides who mints the name (§9). */
    adapter?: 'kubernetes' | 'cloudrun';
  } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: 'web',
      kind: 'service',
      expose: true,
      reach: options.reach ?? 'private',
      auth: options.auth ?? 'proxy',
    })
    .returning();
  const [target] = await db
    .insert(targets)
    .values(
      targetValues({
        name: `cluster-${crypto.randomUUID()}`,
        adapter: options.adapter ?? 'kubernetes',
      }),
    )
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abcdef0',
      targetShape: 'image',
      artifactType: 'image',
      artifactDigest: DIGEST,
      status: 'SUCCEEDED',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      targetId: target!.id,
      buildId: build!.id,
      phase: 'PENDING',
      reach: options.reach ?? 'private',
      auth: options.auth ?? 'proxy',
    })
    .returning();
  await db.insert(componentTargetDesired).values({
    componentId: component!.id,
    targetId: target!.id,
    desiredBuildId: build!.id,
    desiredDeployId: deploy!.id,
  });

  return {
    app: app!,
    component: component!,
    target: target!,
    build: build!,
    deploy: deploy!,
  };
}

async function deployRow(id: number) {
  const [row] = await database()
    .db.select()
    .from(deploys)
    .where(eq(deploys.id, id));
  return row;
}

describe('claiming (§6, SKIP LOCKED)', () => {
  test('a claim moves PENDING to APPLYING and is taken once', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter();

    const first = await claimNextDeploy(context(adapter));
    expect(first?.id).toBe(deploy.id);
    expect(first?.phase).toBe('APPLYING');

    // The claim is the phase, not a held lock: a second worker looking now sees
    // nothing to take, which is what stops two reconcilers applying one intent.
    const second = await claimNextDeploy(context(adapter));
    expect(second).toBeNull();
  });

  test('intents are claimed oldest first', async () => {
    const first = await pendingDeploy();
    const [later] = await database()
      .db.insert(deploys)
      .values({
        componentId: first.component.id,
        targetId: first.target.id,
        buildId: first.build.id,
        phase: 'PENDING',
      })
      .returning();

    const adapter = new FakeDeployAdapter();
    const claimed = await claimNextDeploy(context(adapter));
    expect(claimed?.id).toBe(first.deploy.id);
    expect(claimed?.id).not.toBe(later!.id);
  });

  test('a contended pair is skipped and its newer intent waits behind the claim', async () => {
    const first = await pendingDeploy();
    const [later] = await database()
      .db.insert(deploys)
      .values({
        componentId: first.component.id,
        targetId: first.target.id,
        buildId: first.build.id,
        phase: 'PENDING',
      })
      .returning();
    await database()
      .db.update(componentTargetDesired)
      .set({ desiredDeployId: later!.id })
      .where(eq(componentTargetDesired.componentId, first.component.id));

    const adapter = new FakeDeployAdapter();
    const otherDb = createDb(database().connect());
    let contendedClaim: Awaited<ReturnType<typeof claimNextDeploy>> = null;
    await database().db.transaction(async (tx) => {
      // Hold the same durable pair row that a replica's claim transaction
      // locks. The other replica must skip the pair, including its newer
      // Deploy, rather than depending on scheduler timing to overlap.
      await tx
        .select({ componentId: componentTargetDesired.componentId })
        .from(componentTargetDesired)
        .where(eq(componentTargetDesired.componentId, first.component.id))
        .for('update');
      contendedClaim = await claimNextDeploy(context(adapter, { db: otherDb }));
    });

    expect(contendedClaim).toBeNull();
    expect((await claimNextDeploy(context(adapter)))?.id).toBe(first.deploy.id);
    expect(await claimNextDeploy(context(adapter, { db: otherDb }))).toBeNull();
    expect(await deployRow(later!.id)).toMatchObject({ phase: 'PENDING' });
  });

  test('an abandoned in-flight phase becomes claimable after its timeout', async () => {
    const { deploy } = await pendingDeploy();
    await database()
      .db.update(deploys)
      .set({
        phase: 'WAITING',
        updatedAt: new Date(FROZEN.getTime() - DEFAULT_CLAIM_TIMEOUT_MS - 1),
      })
      .where(eq(deploys.id, deploy.id));

    const claimed = await claimNextDeploy(context(new FakeDeployAdapter()));

    expect(claimed?.id).toBe(deploy.id);
    expect(claimed?.phase).toBe('APPLYING');
  });
});

describe('phases come from the platform, not from core (§6)', () => {
  test('the adapter’s status events drive the row through to LIVE', async () => {
    const { deploy } = await pendingDeploy();
    const at = FROZEN;
    const adapter = new FakeDeployAdapter({
      script: [
        {
          events: [
            { type: 'status', at, phase: 'APPLYING' },
            {
              type: 'log',
              at,
              line: 'creating HelmRelease',
              resource: 'hr/web',
            },
            { type: 'status', at, phase: 'WAITING', resource: 'hr/web' },
          ],
          verdict: { phase: 'LIVE', ref: 'hr/apps/web' },
        },
      ],
    });

    const claimed = await claimNextDeploy(context(adapter));
    const outcome = await runAttempt(context(adapter), claimed!);

    expect(outcome?.phase).toBe('LIVE');
    const row = await deployRow(deploy.id);
    expect(row?.phase).toBe('LIVE');
    // §6: the adapter's handle is opaque to core, stored and handed back.
    expect(row?.ref).toBe('hr/apps/web');
    // §9: core minted the canonical name, so the URL is core's and the adapter
    // had nothing to add.
    expect(row?.url).toBe(`https://shop-web.${manifest.dns.zones.private}`);

    // The whole timeline landed on the one attempt log the UI subscribes to.
    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(events.map((event) => event.phase ?? event.line)).toEqual([
      'APPLYING',
      'creating HelmRelease',
      'WAITING',
      'LIVE',
    ]);
  });

  test('core describes the neutral DesiredState the adapter renders', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter();

    const claimed = await claimNextDeploy(context(adapter));
    await runAttempt(context(adapter), claimed!);

    expect(adapter.applied).toHaveLength(1);
    const desired = adapter.applied[0]!.desired;
    expect(desired.app).toBe('shop');
    expect(desired.component).toBe('web');
    expect(desired.kind).toBe('service');
    expect(desired.artifact.digest).toBe(DIGEST);
    expect(desired.deploy).toBe(String(deploy.id));
    // Flat, and the App leads: one label under the zone is what a wildcard
    // certificate binds, and what makes the name resolvable over TLS at all.
    expect(desired.hostname.canonical).toBe(
      `shop-web.${manifest.dns.zones.private}`,
    );
  });
});

describe('§6: every reason, with the blame the table assigns', () => {
  // BUILD_FAILED is in the shared vocabulary but cannot arrive from `apply` —
  // §6: "a reason that cannot apply to a phase simply never occurs there."
  const fromApply = FAILURE_REASONS.filter(
    (reason) => reason !== 'BUILD_FAILED',
  );

  for (const reason of fromApply) {
    test(`${reason} is recorded with blame ${String(BLAME[reason])}`, async () => {
      const { deploy } = await pendingDeploy();
      // The fake supplies a reason and never a blame — §6 makes blame core's
      // derivation so two adapters cannot indict different people.
      const verdict: DeployVerdict = {
        phase: 'FAILED',
        reason,
        detail: `the platform said ${reason}`,
      };
      const adapter = new FakeDeployAdapter({ script: [{ verdict }] });

      const claimed = await claimNextDeploy(context(adapter));
      const outcome = await runAttempt(context(adapter), claimed!);

      expect(outcome?.phase).toBe('FAILED');
      const row = await deployRow(deploy.id);
      expect(row?.phase).toBe('FAILED');
      expect(row?.reason).toBe(reason);
      expect(row?.blame).toBe(BLAME[reason]);
      expect(row?.detail).toBe(`the platform said ${reason}`);
    });
  }

  test('an adapter that throws is INTERNAL and blamed on the platform', async () => {
    const { deploy } = await pendingDeploy();
    // `apply` is contracted not to throw, but an adapter is code. An attempt
    // that ended by crashing the loop would stay APPLYING forever.
    const adapter = new FakeDeployAdapter({
      applyThrows: 'the adapter has a bug',
    });

    const claimed = await claimNextDeploy(context(adapter));
    const outcome = await runAttempt(context(adapter), claimed!);

    expect(outcome?.phase).toBe('FAILED');
    const row = await deployRow(deploy.id);
    expect(row?.reason).toBe('INTERNAL');
    expect(row?.blame).toBe('platform');
    expect(row?.detail).toBe('the adapter has a bug');
  });
});

describe('§12: the diagnosis outlives the platform', () => {
  test('it is readable after the far side has forgotten everything', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [
        {
          verdict: {
            phase: 'FAILED',
            reason: 'REJECTED',
            detail: 'admission webhook "policy.example" denied the request',
            debug: { events: [{ reason: 'FailedCreate' }] },
          },
        },
      ],
    });

    const claimed = await claimNextDeploy(context(adapter));
    await runAttempt(context(adapter), claimed!);

    // Simulate the hour passing: cluster events expire and the backend can no
    // longer answer the question at all. §12 is the whole reason this is
    // survivable — "the platform will not keep it", so core did.
    const expired = new FakeDeployAdapter({
      applyThrows: 'the events are gone',
    });
    expired.observe = async () => null;

    // Keep running against that amnesiac backend. Nothing may overwrite or
    // clear what was already explained — a later pass that blanked the row
    // because the platform no longer remembers would lose the only copy.
    await runDeployPass(context(expired));

    const row = await deployRow(deploy.id);
    expect(row?.reason).toBe('REJECTED');
    expect(row?.blame).toBe('developer');
    expect(row?.detail).toContain('admission webhook');
    expect(row?.debug).toEqual({ events: [{ reason: 'FailedCreate' }] });
  });
});

describe('§9: one vanity name, and never two claimants', () => {
  // On a backend that names its own workloads. Where core mints the canonical
  // it now mints a flat name directly, so there is no second layer to contend
  // for — the contention this describes is real only where the layer survives.
  const claimant = () =>
    pendingDeploy({ adapter: 'cloudrun', reach: 'public', auth: 'none' });
  /** The fake standing in for that backend, so the loop has one to call. */
  const claimantAdapter = () => new FakeDeployAdapter({ adapter: 'cloudrun' });

  test('a sole serving Component carries the App’s vanity name', async () => {
    const { app } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));

    const adapter = claimantAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied[0]?.desired.hostname.vanity).toBe(
      `shop.${manifest.dns.zones.public}`,
    );
  });

  test('a second serving Component means neither gets it', async () => {
    // §9 puts the vanity name on the App and the canonical on each Component.
    // Handing one name to two Components puts the same hostname on two routes,
    // and the platform resolves that collision arbitrarily — which is worse
    // than the App simply not having a front-door name yet.
    const { app, component, target, build } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));
    await database().db.insert(components).values({
      appId: app.id,
      name: 'admin',
      kind: 'service',
      expose: true,
    });

    const adapter = claimantAdapter();
    await runDeployPass(context(adapter));

    const desired = adapter.applied[0]?.desired;
    expect(desired?.hostname.vanity).toBeUndefined();
    // The canonical is the platform's own here, reported back across the deploy
    // seam rather than minted — so core hands over an empty one.
    expect(desired?.hostname.canonical).toBe('');
    expect(component.id).toBeDefined();
    expect(target.id).toBeDefined();
    expect(build.id).toBeDefined();
  });

  test('an unexposed sibling is not a claimant', async () => {
    // §2: an unexposed service is a queue worker, and a job serves nothing.
    // Neither can contend for the App's front door.
    const { app } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));
    await database().db.insert(components).values({
      appId: app.id,
      name: 'worker',
      kind: 'service',
      expose: false,
    });
    await database()
      .db.insert(components)
      .values({ appId: app.id, name: 'nightly', kind: 'job' });

    const adapter = claimantAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied[0]?.desired.hostname.vanity).toBe(
      `shop.${manifest.dns.zones.public}`,
    );
  });
});

describe('§9: reach and auth never mutate on red', () => {
  test('a failed attempt leaves the Component and the Deploy as they were', async () => {
    const { deploy, component } = await pendingDeploy({
      reach: 'public',
      auth: 'none',
    });
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'FAILED', reason: 'STARTUP_FAILED' } }],
    });

    const claimed = await claimNextDeploy(context(adapter));
    await runAttempt(context(adapter), claimed!);

    const row = await deployRow(deploy.id);
    expect(row?.phase).toBe('FAILED');
    // The App is exactly as reachable as it was: the previous release is still
    // serving, and quietly tightening this would turn one red deploy into an
    // outage nobody asked for.
    expect(row?.reach).toBe('public');
    expect(row?.auth).toBe('none');

    const [after] = await database()
      .db.select()
      .from(components)
      .where(eq(components.id, component.id));
    expect(after?.reach).toBe('public');
    expect(after?.auth).toBe('none');
  });
});

describe('drift is surfaced, never corrected (§6)', () => {
  test('a digest that is not the desired one is reported and left alone', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });

    await runDeployPass(context(adapter));

    // Somebody changed what is running underneath us.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });

    const pass = await runDeployPass(context(adapter));
    const report = pass.drift.find((entry) => entry.deployId === deploy.id);
    expect(report?.drifted).toBe(true);

    // Reported, and nothing else: no second apply went out to put it back.
    // §6 — the re-converge is one click a human takes, not something a loop does
    // to a cluster somebody may have changed on purpose during an incident.
    expect(adapter.applied).toHaveLength(1);

    // And it is a *state*, not just a return value. §6 asks for drift to be
    // visible, and the UI reads rows — a finding that lived for the length of
    // one pass would be surfaced to nobody.
    const row = await deployRow(deploy.id);
    expect(row?.phase).toBe('LIVE');
    expect(row?.driftedAt).toEqual(FROZEN);
    expect(row?.observedDigest).toBe(`sha256:${'b'.repeat(64)}`);
  });

  test('a release the platform will not apply has drifted, digest or not', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    // The shape that went unnoticed for a day in the live installation: the
    // chart's value contract moved, the stored values no longer render, and
    // every reconcile fails behind a previous release that keeps serving. The
    // digest still matches, so comparing digests alone reads this as converged.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      reason: 'INTERNAL',
      detail:
        'execution error at (spindrift-app/templates/httproute.yaml:26:4): platform.gateway.name is required',
    });

    const pass = await runDeployPass(context(adapter));
    const report = pass.drift.find((entry) => entry.deployId === deploy.id);
    expect(report?.drifted).toBe(true);

    // Still surfaced and still not corrected: the re-converge stays a click.
    expect(adapter.applied).toHaveLength(1);

    const row = await deployRow(deploy.id);
    // The Deploy did not fail — it reached LIVE and the platform stopped
    // agreeing afterwards. §9's "exposure never mutates on red" is the same
    // argument: the previous release is up, and calling this FAILED would say
    // an outage that is not happening.
    expect(row?.phase).toBe('LIVE');
    expect(row?.driftedAt).toEqual(FROZEN);
    // The platform's own sentence, which is the only thing that names the value
    // the chart rejected. A drift flag without it says something is wrong
    // without saying that waiting will not fix it.
    expect(row?.driftDetail).toContain('platform.gateway.name is required');
  });

  test('an ordinary digest mismatch records no refusal detail', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });
    await runDeployPass(context(adapter));

    // Nothing refused anything here — something else is simply serving, which
    // `observedDigest` already explains. A detail invented for this case would
    // be the screen claiming the platform said something it did not.
    const row = await deployRow(deploy.id);
    expect(row?.driftedAt).toEqual(FROZEN);
    expect(row?.driftDetail).toBeNull();
  });

  test('a refusal that is resolved clears its detail with the flag', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      reason: 'INTERNAL',
      detail: 'values rejected by the chart',
    });
    await runDeployPass(context(adapter));
    expect((await deployRow(deploy.id))?.driftDetail).not.toBeNull();

    // A redeploy rewrote the values and the object applies again. The sentence
    // has to go with the flag: a stale refusal left on the row would keep
    // explaining a state that no longer exists.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: DIGEST,
    });
    await runDeployPass(context(adapter));

    const row = await deployRow(deploy.id);
    expect(row?.driftedAt).toBeNull();
    expect(row?.driftDetail).toBeNull();
  });

  test('drift fixed out of band stops being reported, with no dismissal', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
    });
    await runDeployPass(context(adapter));
    expect((await deployRow(deploy.id))?.driftedAt).toEqual(FROZEN);

    // Somebody put it back by hand. Nothing should have to be clicked for the
    // state to clear — it is an observation, not an acknowledgement.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: DIGEST,
    });
    const pass = await runDeployPass(context(adapter));

    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id)?.drifted,
    ).toBe(false);
    const row = await deployRow(deploy.id);
    expect(row?.driftedAt).toBeNull();
    expect(row?.observedDigest).toBe(DIGEST);
  });

  test('a Target that cannot be reached has not drifted', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    adapter.observe = async () => {
      throw new Error('dial tcp: no route to host');
    };

    const pass = await runDeployPass(context(adapter));
    // An uplink blip is not a developer changing something, and reporting it as
    // drift would make every satellite hiccup look like a person.
    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id),
    ).toBeUndefined();
  });
});

describe('the poll is the correctness path (plan, Transport shape)', () => {
  test('a pass converges every pending intent with no notification wired', async () => {
    // Nothing in this file ever wires a wake-up. If `NOTIFY` were load-bearing
    // rather than an optimization, none of these tests would converge at all —
    // which is the point: notifications are lost when no listener is connected.
    const first = await pendingDeploy();
    const scripted: ScriptedAttempt = {
      verdict: { phase: 'LIVE', ref: `hr/${crypto.randomUUID()}` },
    };
    await database().db.insert(deploys).values({
      componentId: first.component.id,
      targetId: first.target.id,
      buildId: first.build.id,
      phase: 'PENDING',
    });

    const adapter = new FakeDeployAdapter({ script: [scripted] });
    const pass = await runDeployPass(context(adapter));

    // Both intents were drained in one pass rather than one per interval.
    expect(pass.applied).toHaveLength(2);
    expect(pass.applied.every((outcome) => outcome.phase === 'LIVE')).toBe(
      true,
    );

    const rows = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.componentId, first.component.id));
    expect(rows.every((row) => row.phase === 'LIVE')).toBe(true);
  });

  test('the interval is fast only while something is in flight', async () => {
    expect(intervalFor(['LIVE'])).toBe(DEFAULT_INTERVALS.slowMs);
    expect(intervalFor(['FAILED'])).toBe(DEFAULT_INTERVALS.slowMs);
    // The converged cadence is also the drift cadence — drift is information,
    // not an alarm, so it is checked in minutes rather than seconds.
    expect(intervalFor([])).toBe(DEFAULT_INTERVALS.slowMs);
    expect(intervalFor(['LIVE', 'APPLYING'])).toBe(DEFAULT_INTERVALS.fastMs);
    expect(intervalFor(['WAITING'])).toBe(DEFAULT_INTERVALS.fastMs);
  });
});
