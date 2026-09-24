/**
 * The deploy loop. Core derives blame from the reason, a stored diagnosis
 * outlives the platform's events, reach never changes on red, and the poll
 * converges with no `NOTIFY` wake-up wired.
 */
import { describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import {
  BLAME,
  type DeployVerdict,
  FAILURE_REASONS,
} from '../../src/adapters/deploy/contract.ts';
import type { DnsPublisher } from '../../src/adapters/dns/contract.ts';
import { cancelDeploy } from '../../src/commands/deploys/cancel.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
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
import { APEX, zoneFor } from '../../src/domain/naming.ts';
import { targetLabel } from '../../src/domain/target.ts';
import {
  claimNextDeploy,
  DEFAULT_CLAIM_TIMEOUT_MS,
  DEFAULT_INTERVALS,
  DEPLOY_ATTEMPT_MAX_MS,
  DEPLOY_SOAK_MS,
  type DeployLoopContext,
  heartbeatAttempt,
  intervalFor,
  runAttempt,
  runDeployPass,
} from '../../src/reconciler/deploy-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  FakeDeployAdapter,
  type ScriptedAttempt,
} from '../harness/fakes/deploy-adapter.ts';
import { FakeDnsPublisher } from '../harness/fakes/dns-publisher.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };
const DIGEST = `sha256:${'a'.repeat(64)}`;

function context(
  adapter: FakeDeployAdapter,
  overrides: Partial<DeployLoopContext> = {},
  dns?: DnsPublisher,
): DeployLoopContext {
  const adapters: Pick<AdapterRegistry, 'deploy' | 'dns'> = {
    deploy: (name) => (name === adapter.adapter ? adapter : null),
    ...(dns === undefined ? {} : { dns: () => dns }),
  };
  return { db: database().db, adapters, clock, manifest, ...overrides };
}

/** An App, Component, Target, Build, and one PENDING Deploy intent. */
async function pendingDeploy(
  options: {
    reach?: 'none' | 'private' | 'public';
    auth?: 'none' | 'proxy';
    /** The backend decides who mints the canonical name. */
    adapter?: 'kubernetes' | 'cloudrun';
    kind?: 'service' | 'job';
    /** The Component's declared cadence, the desired half of drift. */
    schedule?: string;
    /** The two halves of the canonical name core mints. */
    appName?: string;
    componentName?: string;
  } = {},
) {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: options.appName ?? 'shop', sourceKind: 'archive' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({
      appId: app!.id,
      name: options.componentName ?? 'web',
      kind: options.kind ?? 'service',
      expose: true,
      reach: options.reach ?? 'private',
      auth: options.auth ?? 'proxy',
      ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    })
    .returning();
  const adapter = options.adapter ?? 'kubernetes';
  const vessel = await insertVessel(db, adapter, {
    name: `cluster-${crypto.randomUUID()}`,
  });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id, adapter }))
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
      // The document names what this fixture actually created, because the
      // adapter is handed these names and the hostname is built from them.
      desired: aDesiredDocument({
        app: app!.name,
        component: component!.name,
        target: targetLabel({ vessel: vessel.name, adapter }),
        reach: options.reach ?? 'private',
        auth: options.auth ?? 'proxy',
      }),
      targetId: target!.id,
      buildId: build!.id,
      phase: 'PENDING',
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

    // The claim is the phase itself, so a second worker finds nothing to take.
    const second = await claimNextDeploy(context(adapter));
    expect(second).toBeNull();
  });

  test('intents are claimed oldest first', async () => {
    const first = await pendingDeploy();
    const [later] = await database()
      .db.insert(deploys)
      .values({
        componentId: first.component.id,
        desired: aDesiredDocument(),
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
        desired: aDesiredDocument(),
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
      // Hold the pair row a claim locks, so the other replica has to skip the
      // pair and its newer Deploy without relying on timing.
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
    // The adapter's handle is opaque to core: stored and handed back.
    expect(row?.ref).toBe('hr/apps/web');
    // Core minted the canonical name, so the URL is core's.
    expect(row?.url).toBe(
      `https://shop-web.${zoneFor('private', manifest.dns.zones)}`,
    );

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
    // One label under the zone, because a wildcard certificate covers only
    // that.
    expect(desired.hostname.canonical).toBe(
      `shop-web.${zoneFor('private', manifest.dns.zones)}`,
    );
  });

  test('a Component edited after the intent does not change what it places', async () => {
    const { deploy, component } = await pendingDeploy();

    // The intent's pinned document wins over a later edit to the Component.
    await database()
      .db.update(components)
      .set({ kind: 'job', expose: false, schedule: '0 3 * * *' })
      .where(eq(components.id, component.id));

    const adapter = new FakeDeployAdapter();
    const claimed = await claimNextDeploy(context(adapter));
    await runAttempt(context(adapter), claimed!);

    const desired = adapter.applied[0]!.desired;
    expect(desired.kind).toBe('service');
    expect(desired.expose).toBe(true);
    expect(desired.schedule).toBeUndefined();
    expect(desired.deploy).toBe(String(deploy.id));

    // A rollback reads the row, which still says so.
    const [row] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, deploy.id));
    expect(row?.desired.kind).toBe('service');
  });
});

describe('§6: every reason, with the blame the table assigns', () => {
  // BUILD_FAILED is in the shared vocabulary but cannot come from `apply`.
  const fromApply = FAILURE_REASONS.filter(
    (reason) => reason !== 'BUILD_FAILED',
  );

  for (const reason of fromApply) {
    test(`${reason} is recorded with blame ${String(BLAME[reason])}`, async () => {
      const { deploy } = await pendingDeploy();
      // The fake never supplies blame: core derives it, so adapters cannot
      // disagree on it.
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
    // `apply` must not throw, but if it does the attempt must not stay
    // APPLYING.
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

    // Cluster events expire in about an hour, after which the backend knows
    // nothing.
    const expired = new FakeDeployAdapter({
      applyThrows: 'the events are gone',
    });
    expired.observe = async () => null;

    // A later pass must not clear the stored diagnosis, the only copy left.
    await runDeployPass(context(expired));

    const row = await deployRow(deploy.id);
    expect(row?.reason).toBe('REJECTED');
    expect(row?.blame).toBe('developer');
    expect(row?.detail).toContain('admission webhook');
    expect(row?.debug).toEqual({ events: [{ reason: 'FailedCreate' }] });
  });
});

describe('§9: one vanity name, and never two claimants', () => {
  // Cloud Run names its own workloads, so core mints only the vanity name.
  const claimant = () =>
    pendingDeploy({ adapter: 'cloudrun', reach: 'public', auth: 'none' });
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
      `shop.${zoneFor('public', manifest.dns.zones)}`,
    );
  });

  test('a sole serving Component on a cluster Target carries the vanity name too, beside its own canonical', async () => {
    // The vanity name is the App's own choice, separate from the Component's
    // canonical.
    const { app } = await pendingDeploy();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter();
    await runDeployPass(context(adapter));

    const zone = zoneFor('private', manifest.dns.zones);
    const hostname = adapter.applied[0]?.desired.hostname;
    expect(hostname?.canonical).toBe(`shop-web.${zone}`);
    expect(hostname?.vanity).toBe(`shop.${zone}`);
  });

  test('a second serving Component means neither gets it', async () => {
    // One name on two routes is a collision the platform resolves
    // arbitrarily.
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
    // The platform reports its own canonical back, so core hands over an empty
    // one.
    expect(desired?.hostname.canonical).toBe('');
    expect(component.id).toBeDefined();
    expect(target.id).toBeDefined();
    expect(build.id).toBeDefined();
  });

  test('an unexposed sibling is not a claimant', async () => {
    // An unexposed service and a job serve nothing, so neither contends.
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
      `shop.${zoneFor('public', manifest.dns.zones)}`,
    );
  });
});

describe("§9: no App is served on the installation's own names", () => {
  const expectRejected = async (deployId: number, name: string) => {
    const row = await deployRow(deployId);
    expect(row?.phase).toBe('FAILED');
    expect(row?.reason).toBe('REJECTED');
    expect(row?.detail).toContain(name);
  };

  test('a stored vanity label that mints the control plane never reaches the adapter', async () => {
    // Written straight to the row, past `setAppVanity`'s refusal.
    const { app, deploy } = await pendingDeploy({
      reach: 'public',
      auth: 'none',
    });
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'spindrift' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied).toHaveLength(0);
    await expectRejected(deploy.id, manifest.controlPlane.hostname);
  });

  test('a canonical name that is the public hostname is refused the same way', async () => {
    const { deploy } = await pendingDeploy({
      reach: 'public',
      auth: 'none',
      appName: 'spindrift',
      componentName: 'control',
    });

    const adapter = new FakeDeployAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied).toHaveLength(0);
    await expectRejected(deploy.id, manifest.controlPlane.publicHostname!);
  });

  test('a stored vanity label that mints a reserved hostname is refused the same way', async () => {
    const { app, deploy } = await pendingDeploy({
      reach: 'public',
      auth: 'none',
    });
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'kthx' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied).toHaveLength(0);
    await expectRejected(
      deploy.id,
      manifest.controlPlane.reservedHostnames[0]!,
    );
  });

  test('the same names in a zone the installation is not served in deploy', async () => {
    const { deploy } = await pendingDeploy({
      appName: 'spindrift',
      componentName: 'control',
    });

    const adapter = new FakeDeployAdapter();
    await runDeployPass(context(adapter));

    expect(adapter.applied).toHaveLength(1);
    expect((await deployRow(deploy.id))?.phase).toBe('LIVE');
  });
});

describe('§9: dns publishing on a platform-named Target (ticket 137b)', () => {
  // `cloudrun` stands for any platform-named Target: `!coreMintsCanonical`
  // gates this, not the adapter type.
  const claimant = () =>
    pendingDeploy({ adapter: 'cloudrun', reach: 'public', auth: 'none' });

  const withAddress: ScriptedAttempt = {
    verdict: {
      phase: 'LIVE',
      ref: 'run/shop-web',
      address: {
        recordType: 'CNAME',
        target: 'shop-web.a.run.app',
        proxied: true,
      },
    },
  };

  test('a vanity name and a reported address publish the record', async () => {
    const { app } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [withAddress],
    });
    const dns = new FakeDnsPublisher();

    await runDeployPass(context(adapter, {}, dns));

    const zone = zoneFor('public', manifest.dns.zones);
    expect(dns.published).toEqual([
      {
        name: 'shop-web',
        record: {
          dnsName: `shop.${zone}`,
          recordType: 'CNAME',
          target: 'shop-web.a.run.app',
          proxied: true,
        },
      },
    ]);
    expect(dns.withdrawn).toEqual([]);
  });

  test('an apex is stated as published once, not as a re-point', async () => {
    // external-dns cannot write its ownership marker at a zone apex, so only
    // the create lands, and the log must not claim a later re-point.
    const { app, deploy } = await claimant();
    const zone = zoneFor('public', manifest.dns.zones) as string;
    await database()
      .db.update(apps)
      .set({ vanityDomain: APEX })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [withAddress],
    });
    const dns = new FakeDnsPublisher();

    await runDeployPass(context(adapter, {}, dns));

    // The record matches a label's; only the log line differs.
    expect(dns.published).toEqual([
      {
        name: 'shop-web',
        record: {
          dnsName: zone,
          recordType: 'CNAME',
          target: 'shop-web.a.run.app',
          proxied: true,
        },
      },
    ]);

    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    const lines = events.map((event) => event.line ?? '').join('\n');
    expect(lines).toContain('published once and never re-pointed');
    expect(lines).not.toContain(`published ${zone} ->`);
  });

  test('no vanity name withdraws rather than publishing', async () => {
    // `withdraw` runs even when nothing was ever published, and is idempotent.
    await claimant();

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [withAddress],
    });
    const dns = new FakeDnsPublisher();

    await runDeployPass(context(adapter, {}, dns));

    expect(dns.withdrawn).toEqual(['shop-web']);
    expect(dns.published).toEqual([]);
  });

  test('with no DNS publisher configured, the deploy still lands LIVE and the log says so', async () => {
    const { app, deploy } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [withAddress],
    });
    const pass = await runDeployPass(context(adapter));

    expect(pass.applied[0]?.phase).toBe('LIVE');
    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(
      events.some((event) => event.line?.includes('no DNS publisher')),
    ).toBe(true);
  });

  test('a publish that throws leaves the deploy LIVE, with the failure on the attempt log', async () => {
    const { app, deploy } = await claimant();
    await database()
      .db.update(apps)
      .set({ vanityDomain: 'shop' })
      .where(eq(apps.id, app.id));

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [withAddress],
    });
    const dns = new FakeDnsPublisher({ publishThrows: 'the zone refused it' });

    const pass = await runDeployPass(context(adapter, {}, dns));

    // The workload is up, so a failed DNS write does not fail the deploy.
    expect(pass.applied[0]?.phase).toBe('LIVE');
    expect((await deployRow(deploy.id))?.phase).toBe('LIVE');
    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(
      events.some((event) => event.line?.includes('the zone refused it')),
    ).toBe(true);
  });
});

describe('§9: a LIVE row states the name a developer shares', () => {
  // The row holds one URL: the vanity name where it resolves, else the
  // canonical.
  const address = {
    recordType: 'CNAME',
    target: 'shop-web.a.run.app',
    proxied: true,
  } as const;
  const platformNamed = () =>
    pendingDeploy({ adapter: 'cloudrun', reach: 'public', auth: 'none' });

  async function named(appId: string, label: string) {
    await database()
      .db.update(apps)
      .set({ vanityDomain: label })
      .where(eq(apps.id, appId));
  }

  test('a cluster Target’s row is the vanity, not the canonical it also minted', async () => {
    // The chart is handed both names, so both resolve.
    const { app, deploy } = await pendingDeploy();
    await named(app.id, 'shop');

    await runDeployPass(context(new FakeDeployAdapter()));

    expect((await deployRow(deploy.id))?.url).toBe(
      `https://shop.${zoneFor('private', manifest.dns.zones)}`,
    );
  });

  test('an apex reads as the bare zone, not as the platform’s own name', async () => {
    const { app, deploy } = await platformNamed();
    await named(app.id, APEX);

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [
        {
          verdict: {
            phase: 'LIVE',
            ref: 'run/shop-web',
            url: 'https://shop-web.a.run.app',
            address,
          },
        },
      ],
    });
    await runDeployPass(context(adapter, {}, new FakeDnsPublisher()));

    expect((await deployRow(deploy.id))?.url).toBe(
      `https://${zoneFor('public', manifest.dns.zones)}`,
    );
  });

  test('a Target that reports no address keeps the platform’s own name', async () => {
    // With no address nothing points the vanity name anywhere, so the row
    // must not print it.
    const { app, deploy } = await platformNamed();
    await named(app.id, 'shop');

    const adapter = new FakeDeployAdapter({
      adapter: 'cloudrun',
      script: [
        {
          verdict: {
            phase: 'LIVE',
            ref: 'run/shop-web',
            url: 'https://shop-web.a.run.app',
          },
        },
      ],
    });
    await runDeployPass(context(adapter, {}, new FakeDnsPublisher()));

    expect((await deployRow(deploy.id))?.url).toBe(
      'https://shop-web.a.run.app',
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
    // The previous release still serves, so its reach must not change.
    expect(row?.desired.reach).toBe('public');
    expect(row?.desired.auth).toBe('none');

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

    // Reported only. Re-converging is a human's click, because the change may
    // be deliberate.
    expect(adapter.applied).toHaveLength(1);

    // Drift is stored on the row, which is what the UI reads.
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

    // The stored values no longer render, so every reconcile fails behind a
    // previous release that keeps serving and still matches the digest.
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

    expect(adapter.applied).toHaveLength(1);

    const row = await deployRow(deploy.id);
    // It reached LIVE and the previous release is up, so FAILED would claim
    // an outage.
    expect(row?.phase).toBe('LIVE');
    expect(row?.driftedAt).toEqual(FROZEN);
    // Only the platform's sentence names the value the chart rejected.
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

    // Nothing refused anything; `observedDigest` already explains this drift.
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

    // The object applies again, so the detail clears with the flag.
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

  test('a schedule that stopped firing is drift, digest and phase or not', async () => {
    const { deploy } = await pendingDeploy({
      kind: 'job',
      schedule: '0 3 * * *',
    });
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'jobs/nightly' } }],
    });
    await runDeployPass(context(adapter));

    // The Job is LIVE at the desired digest, but its schedule is gone.
    adapter.place('jobs/nightly', {
      ref: 'jobs/nightly',
      phase: 'LIVE',
      artifactDigest: DIGEST,
      schedule: null,
    });

    const pass = await runDeployPass(context(adapter));
    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id)?.drifted,
    ).toBe(true);

    const row = await deployRow(deploy.id);
    expect(row?.driftedAt).toEqual(FROZEN);
    expect(row?.driftDetail).toContain('0 3 * * *');
    expect(row?.driftDetail).toContain('nothing is firing this job');

    expect(adapter.applied).toHaveLength(1);
  });

  test('a job nobody scheduled is not drifted for having no schedule', async () => {
    // Most jobs have no schedule, so none observed is no drift.
    const { deploy } = await pendingDeploy({ kind: 'job' });
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'jobs/nightly' } }],
    });
    await runDeployPass(context(adapter));

    adapter.place('jobs/nightly', {
      ref: 'jobs/nightly',
      phase: 'LIVE',
      artifactDigest: DIGEST,
      schedule: null,
    });

    const pass = await runDeployPass(context(adapter));
    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id)?.drifted,
    ).toBe(false);
    expect((await deployRow(deploy.id))?.driftedAt).toBeNull();
  });

  test('a backend that reports no cadence is never drifted for one', async () => {
    // Services and Kubernetes placements omit `schedule`. Absent means not
    // applicable, where `null` means nothing fires the job.
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [{ verdict: { phase: 'LIVE', ref: 'hr/apps/web' } }],
    });
    await runDeployPass(context(adapter));

    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: DIGEST,
    });

    const pass = await runDeployPass(context(adapter));
    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id)?.drifted,
    ).toBe(false);
    expect((await deployRow(deploy.id))?.driftedAt).toBeNull();
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

    // Put back by hand, the flag clears on observation with no dismissal.
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
    // An unreachable Target is no evidence that anything changed.
    expect(
      pass.drift.find((entry) => entry.deployId === deploy.id),
    ).toBeUndefined();
  });

  test('a release a newer intent superseded is not observed at all', async () => {
    // `phase` is never edited after the verdict, so a superseded release stays
    // LIVE, and observing it would report drift on every pass.
    const { component, target, deploy: older } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({
      script: [
        { verdict: { phase: 'LIVE', ref: 'hr/apps/web' } },
        { verdict: { phase: 'LIVE', ref: 'hr/apps/web' } },
      ],
    });
    await runDeployPass(context(adapter));

    const db = database().db;
    const nextDigest = `sha256:${'c'.repeat(64)}`;
    const [build] = await db
      .insert(builds)
      .values({
        componentId: component.id,
        commit: 'bcdef01',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: nextDigest,
        status: 'SUCCEEDED',
      })
      .returning();
    const [newer] = await db
      .insert(deploys)
      .values({
        componentId: component.id,
        desired: aDesiredDocument(),
        targetId: target.id,
        buildId: build!.id,
        phase: 'PENDING',
      })
      .returning();
    await db
      .update(componentTargetDesired)
      .set({ desiredBuildId: build!.id, desiredDeployId: newer!.id })
      .where(eq(componentTargetDesired.componentId, component.id));

    const pass = await runDeployPass(context(adapter));

    expect((await deployRow(older.id))?.phase).toBe('LIVE');
    expect((await deployRow(newer!.id))?.phase).toBe('LIVE');
    expect(pass.drift.map((entry) => entry.deployId)).toEqual([newer!.id]);

    expect((await deployRow(older.id))?.driftedAt).toBeNull();
  });
});

describe('the poll is the correctness path (plan, Transport shape)', () => {
  test('a pass converges every pending intent with no notification wired', async () => {
    // No test here wires a wake-up. `NOTIFY` is lost when no listener is
    // connected, so the poll has to converge on its own.
    const first = await pendingDeploy();
    const scripted: ScriptedAttempt = {
      verdict: { phase: 'LIVE', ref: `hr/${crypto.randomUUID()}` },
    };
    await database().db.insert(deploys).values({
      componentId: first.component.id,
      desired: aDesiredDocument(),
      targetId: first.target.id,
      buildId: first.build.id,
      phase: 'PENDING',
    });

    const adapter = new FakeDeployAdapter({ script: [scripted] });
    const pass = await runDeployPass(context(adapter));

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
    // Drift has its own interval, so an idle loop still picks up work in
    // seconds.
    expect(intervalFor([])).toBe(DEFAULT_INTERVALS.slowMs);
    expect(intervalFor(['LIVE', 'APPLYING'])).toBe(DEFAULT_INTERVALS.fastMs);
    expect(intervalFor(['WAITING'])).toBe(DEFAULT_INTERVALS.fastMs);
  });
});

describe('the attempt fence (ticket 129)', () => {
  test('two reconcilers, one Postgres: only the holder lands a verdict', async () => {
    const { deploy } = await pendingDeploy();
    const first = new FakeDeployAdapter();
    const second = new FakeDeployAdapter();
    const otherDb = createDb(database().connect());

    const held = await claimNextDeploy(context(first));
    expect(held?.attemptId).toEqual(expect.any(String));

    // Another reconciler pod, arriving after the first attempt's lease aged
    // out.
    const reclaimed = await claimNextDeploy(
      context(second, {
        db: otherDb,
        clock: {
          now: () => new Date(FROZEN.getTime() + DEFAULT_CLAIM_TIMEOUT_MS + 1),
        },
      }),
    );
    expect(reclaimed?.id).toBe(deploy.id);
    expect(reclaimed?.attemptId).not.toBe(held?.attemptId);

    // The first attempt finishes late, at a verdict it no longer owns.
    const outcome = await runAttempt(context(first), held!);
    expect(outcome?.phase).toBe('LOST');

    const stranded = await deployRow(deploy.id);
    expect(stranded?.attemptId).toBe(reclaimed!.attemptId!);
    expect(stranded?.phase).toBe('APPLYING');
    expect(stranded?.url).toBeNull();

    // Logged, or the stopped attempt reads as a hung rollout.
    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(events.at(-1)?.line).toContain('lost its claim');

    const landed = await runAttempt(
      context(second, { db: otherDb }),
      reclaimed!,
    );
    expect(landed?.phase).toBe('LIVE');
    expect((await deployRow(deploy.id))?.phase).toBe('LIVE');
  });

  test('a heartbeat keeps a long apply out of the reclaim, and only its holder can send one', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter();
    const held = await claimNextDeploy(context(adapter));

    // One tick short of the timeout. An upload that emits only `log` events
    // writes no row update of its own.
    const later = new Date(FROZEN.getTime() + DEFAULT_CLAIM_TIMEOUT_MS - 1);
    const beating = context(adapter, { clock: { now: () => later } });
    expect(await heartbeatAttempt(beating, deploy.id, held!.attemptId)).toBe(
      true,
    );
    expect((await deployRow(deploy.id))?.updatedAt).toEqual(later);

    // Past the original lease but inside the renewed one, so nothing reclaims
    // it.
    const afterOriginalLease = new Date(
      FROZEN.getTime() + DEFAULT_CLAIM_TIMEOUT_MS + 1,
    );
    expect(
      await claimNextDeploy(
        context(adapter, { clock: { now: () => afterOriginalLease } }),
      ),
    ).toBeNull();

    // A heartbeat from a superseded attempt answers false, so it stops early.
    expect(
      await heartbeatAttempt(beating, deploy.id, crypto.randomUUID()),
    ).toBe(false);
  });

  test('past the attempt cap the heartbeat still notices a reclaim without renewing the lease', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter();
    const held = await claimNextDeploy(context(adapter));

    // A reclaim needs DEFAULT_CLAIM_TIMEOUT_MS without a refresh, so it lands
    // past DEPLOY_ATTEMPT_MAX_MS, while the attempt runs without refreshing.
    const afterCap = FROZEN.getTime() + DEPLOY_ATTEMPT_MAX_MS;
    const observing = context(adapter, {
      clock: { now: () => new Date(afterCap) },
    });
    expect(
      await heartbeatAttempt(observing, deploy.id, held!.attemptId, false),
    ).toBe(true);
    // Read-only past the cap, so the lease still expires on schedule.
    expect((await deployRow(deploy.id))?.updatedAt).toEqual(FROZEN);

    const reclaimTime = new Date(afterCap + DEFAULT_CLAIM_TIMEOUT_MS + 1);
    const reclaimed = await claimNextDeploy(
      context(new FakeDeployAdapter(), {
        db: createDb(database().connect()),
        clock: { now: () => reclaimTime },
      }),
    );
    expect(reclaimed?.id).toBe(deploy.id);

    // The still-running attempt learns it lost, and stops writing to a log
    // another attempt owns.
    expect(
      await heartbeatAttempt(
        context(adapter, { clock: { now: () => reclaimTime } }),
        deploy.id,
        held!.attemptId,
        false,
      ),
    ).toBe(false);
  });
});

describe('cancelling an attempt (§6)', () => {
  /** The operator's cancel press, against the loop's isolated schema. */
  function operator(): CommandContext {
    return {
      principal: { id: crypto.randomUUID(), displayName: 'Jordan' },
      clock,
      db: database().db,
      adapters: {
        deploy: () => null,
        build: () => null,
        store: () => {
          throw new Error('cancelling reached the secret store');
        },
        repository: () => null,
        supplyChain: () => {
          throw new Error('cancelling reached the supply chain');
        },
      } as unknown as AdapterRegistry,
      manifest,
    };
  }

  async function eventsOf(deployId: number) {
    return database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deployId))
      .orderBy(asc(attemptEvents.id));
  }

  test('a request during APPLYING ends the stream and settles FAILED with who asked', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter();
    let finished = false;
    let resumed = 0;
    // The press lands between the adapter's events with no timer involved, so
    // the loop must not absorb the second event.
    adapter.apply = async function* () {
      try {
        yield { type: 'status', at: FROZEN, phase: 'APPLYING' };
        resumed += 1;
        const pressed = await cancelDeploy({ id: deploy.id }, operator());
        expect(pressed.ok && pressed.value.phase).toBe('APPLYING');
        yield { type: 'status', at: FROZEN, phase: 'WAITING' };
        resumed += 1;
        return { phase: 'LIVE', ref: 'hr/apps/web' };
      } finally {
        finished = true;
      }
    };

    const claimed = await claimNextDeploy(context(adapter));
    const outcome = await runAttempt(context(adapter), claimed!);

    expect(outcome?.phase).toBe('FAILED');
    // The generator was returned: its `finally` ran, and it never resumed
    // past the event the cancel arrived on.
    expect(finished).toBe(true);
    expect(resumed).toBe(1);

    const row = await deployRow(deploy.id);
    expect(row).toMatchObject({
      phase: 'FAILED',
      // A cancellation blames neither a developer nor the platform.
      reason: null,
      blame: null,
      detail: 'cancelled by Jordan',
      cancelRequestedBy: 'Jordan',
      // Settled by the attempt that held the claim, through its fence.
      attemptId: claimed!.attemptId,
    });

    const events = await eventsOf(deploy.id);
    expect(events.map((event) => event.phase ?? event.line)).toEqual([
      'APPLYING',
      'cancel requested by Jordan; the attempt ends at its next event',
      'cancelled by Jordan',
      'FAILED',
    ]);
    expect(events.at(-1)?.reason).toBeNull();
  });

  test('the fence holds: a reclaimed attempt abandons the request, and the holder honours it', async () => {
    const { deploy } = await pendingDeploy();
    const script: ScriptedAttempt = {
      events: [{ type: 'status', at: FROZEN, phase: 'APPLYING' }],
      verdict: { phase: 'LIVE', ref: 'hr/apps/web' },
    };
    const first = new FakeDeployAdapter({ script: [script] });
    const second = new FakeDeployAdapter({ script: [script] });
    const otherDb = createDb(database().connect());

    const held = await claimNextDeploy(context(first));
    const reclaimed = await claimNextDeploy(
      context(second, {
        db: otherDb,
        clock: {
          now: () => new Date(FROZEN.getTime() + DEFAULT_CLAIM_TIMEOUT_MS + 1),
        },
      }),
    );
    expect(reclaimed?.attemptId).not.toBe(held?.attemptId);

    // The press lands on a row the second attempt now holds.
    const pressed = await cancelDeploy({ id: deploy.id }, operator());
    expect(pressed.ok).toBe(true);

    // The first attempt's fence no longer matches, so neither the request nor
    // the verdict is its own.
    const late = await runAttempt(context(first), held!);
    expect(late?.phase).toBe('LOST');
    const stranded = await deployRow(deploy.id);
    expect(stranded?.phase).toBe('APPLYING');
    expect(stranded?.attemptId).toBe(reclaimed!.attemptId!);

    const landed = await runAttempt(
      context(second, { db: otherDb }),
      reclaimed!,
    );
    expect(landed?.phase).toBe('FAILED');
    expect(await deployRow(deploy.id)).toMatchObject({
      phase: 'FAILED',
      detail: 'cancelled by Jordan',
      attemptId: reclaimed!.attemptId,
    });
  });

  test('a PENDING intent is failed on the spot, the desired pointer goes back, and nothing claims it', async () => {
    const first = await pendingDeploy();
    await runDeployPass(context(new FakeDeployAdapter()));
    expect((await deployRow(first.deploy.id))?.phase).toBe('LIVE');

    // A second intent for the same pair, and the pointer moved onto it the way
    // `placeIntent` moves it.
    const db = database().db;
    const [newer] = await db
      .insert(builds)
      .values({
        componentId: first.component.id,
        commit: 'bcdef01',
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: `sha256:${'b'.repeat(64)}`,
        status: 'SUCCEEDED',
      })
      .returning();
    const [later] = await db
      .insert(deploys)
      .values({
        componentId: first.component.id,
        desired: aDesiredDocument(),
        targetId: first.target.id,
        buildId: newer!.id,
        phase: 'PENDING',
      })
      .returning();
    await db
      .update(componentTargetDesired)
      .set({ desiredBuildId: newer!.id, desiredDeployId: later!.id })
      .where(eq(componentTargetDesired.componentId, first.component.id));

    const pressed = await cancelDeploy({ id: later!.id }, operator());
    expect(pressed).toMatchObject({
      ok: true,
      value: { deployId: later!.id, phase: 'FAILED' },
    });

    // The pointer returns to the previous release, which `deployApp` reads.
    const [desired] = await db
      .select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, first.component.id));
    expect(desired?.desiredDeployId).toBe(first.deploy.id);
    expect(desired?.desiredBuildId).toBe(first.build.id);

    expect(await deployRow(later!.id)).toMatchObject({
      phase: 'FAILED',
      reason: null,
      detail: 'cancelled by Jordan',
      attemptId: null,
    });
    expect(await claimNextDeploy(context(new FakeDeployAdapter()))).toBeNull();

    const events = await eventsOf(later!.id);
    expect(events.map((event) => event.phase ?? event.line)).toEqual([
      'cancelled by Jordan',
      'FAILED',
    ]);
  });
});

describe('the post-LIVE soak (§6)', () => {
  const live: ScriptedAttempt = {
    verdict: { phase: 'LIVE', ref: 'hr/apps/web' },
  };
  const at = (offsetMs: number) => ({
    clock: { now: () => new Date(FROZEN.getTime() + offsetMs) },
  });

  test('a release the platform reports failed inside the window is faulty, with blame and a status line', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({ script: [live] });
    await runDeployPass(context(adapter));

    // Inside the window nothing is judged, however many passes look.
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS - 1)));
    expect(await deployRow(deploy.id)).toMatchObject({
      soakedAt: null,
      faultyAt: null,
    });

    // Readiness held, then failed inside the window.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      reason: 'STARTUP_FAILED',
      detail: 'back-off 5m0s restarting failed container',
    });
    const judged = new Date(FROZEN.getTime() + DEPLOY_SOAK_MS);
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS)));

    const row = await deployRow(deploy.id);
    // Still the platform's verdict on the rollout, and still what is desired.
    expect(row?.phase).toBe('LIVE');
    expect(row?.faultyAt).toEqual(judged);
    expect(row?.soakedAt).toBeNull();
    // Filled the way a red attempt is filled: the blame is core's derivation.
    expect(row?.reason).toBe('STARTUP_FAILED');
    expect(row?.blame).toBe(BLAME.STARTUP_FAILED);
    expect(row?.detail).toContain('back-off');
    expect(row?.debug).toMatchObject({ phase: 'FAILED' });

    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(events.at(-1)).toMatchObject({
      phase: 'FAULTY',
      reason: 'STARTUP_FAILED',
    });
    expect(
      events.some((event) => event.line?.includes('faulty after readiness')),
    ).toBe(true);

    // Judged once: a later recovery clears drift and keeps the soak's verdict.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'LIVE',
      artifactDigest: DIGEST,
    });
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS * 10)));
    expect(await deployRow(deploy.id)).toMatchObject({
      faultyAt: judged,
      reason: 'STARTUP_FAILED',
      driftedAt: null,
    });
  });

  test('a fault the platform names no reason for is recorded in its words, with no blame', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({ script: [live] });
    await runDeployPass(context(adapter));

    // A failed Flux upgrade whose conditions name no reason. Core must not
    // guess one: an image that stopped pulling is not the developer's fault.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      detail: 'Helm upgrade failed: timed out waiting for the condition',
    });
    const judged = new Date(FROZEN.getTime() + DEPLOY_SOAK_MS);
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS)));

    const row = await deployRow(deploy.id);
    expect(row).toMatchObject({
      phase: 'LIVE',
      faultyAt: judged,
      soakedAt: null,
      reason: null,
      blame: null,
      detail: 'Helm upgrade failed: timed out waiting for the condition',
    });

    const events = await database()
      .db.select()
      .from(attemptEvents)
      .where(eq(attemptEvents.deployId, deploy.id))
      .orderBy(asc(attemptEvents.id));
    expect(events.at(-1)).toMatchObject({ phase: 'FAULTY', reason: null });
  });

  test('an object mid-rollout at the window is judged on the next pass, not closed on transient state', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({ script: [live] });
    await runDeployPass(context(adapter));

    // A restart inside the window: same digest, pods being replaced, no
    // verdict.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'WAITING',
      artifactDigest: DIGEST,
    });
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS)));
    expect(await deployRow(deploy.id)).toMatchObject({
      soakedAt: null,
      faultyAt: null,
    });

    // The restarted pods crash-loop.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      reason: 'STARTUP_FAILED',
      detail: 'back-off 5m0s restarting failed container',
    });
    const judged = new Date(FROZEN.getTime() + DEPLOY_SOAK_MS + 1);
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS + 1)));
    expect(await deployRow(deploy.id)).toMatchObject({
      faultyAt: judged,
      soakedAt: null,
      reason: 'STARTUP_FAILED',
      blame: BLAME.STARTUP_FAILED,
    });
  });

  test('a healthy soak stamps soaked_at once, and a later failure is drift rather than a fault', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({ script: [live] });
    await runDeployPass(context(adapter));

    const judged = new Date(FROZEN.getTime() + DEPLOY_SOAK_MS);
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS)));
    expect(await deployRow(deploy.id)).toMatchObject({
      phase: 'LIVE',
      soakedAt: judged,
      faultyAt: null,
      reason: null,
    });

    // Past the window the same observation is drift, with no blame.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: DIGEST,
      reason: 'STARTUP_FAILED',
      detail: 'crash loop',
    });
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS * 10)));
    const row = await deployRow(deploy.id);
    expect(row?.soakedAt).toEqual(judged);
    expect(row?.faultyAt).toBeNull();
    expect(row?.reason).toBeNull();
    expect(row?.driftedAt).not.toBeNull();
  });

  test('an object that now carries a newer release is not judged on this one’s behalf', async () => {
    const { deploy } = await pendingDeploy();
    const adapter = new FakeDeployAdapter({ script: [live] });
    await runDeployPass(context(adapter));

    // A later intent re-applied the object, which fails under its digest, so
    // the newer row carries it.
    adapter.place('hr/apps/web', {
      ref: 'hr/apps/web',
      phase: 'FAILED',
      artifactDigest: `sha256:${'b'.repeat(64)}`,
      reason: 'STARTUP_FAILED',
    });
    const judged = new Date(FROZEN.getTime() + DEPLOY_SOAK_MS);
    await runDeployPass(context(adapter, at(DEPLOY_SOAK_MS)));

    expect(await deployRow(deploy.id)).toMatchObject({
      soakedAt: judged,
      faultyAt: null,
      reason: null,
    });
  });
});
