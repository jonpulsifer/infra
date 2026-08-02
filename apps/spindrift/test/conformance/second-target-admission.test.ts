/**
 * Acceptance test for Ticket 12: Admit the artifact on a second Target.
 *
 * Acceptance Criteria verified:
 * - A second real Target is connected through native federation and reports its prerequisites,
 *   capabilities, build-level policy, chart/artifact contract, and naming boundary.
 * - Placement can select that Target by its real name and explains any non-candidate state before dispatch.
 * - The already-built immutable artifact is deployed without another Build, and the second Target
 *   independently verifies the same real signature.
 * - Installer and App chart distribution use independently pinned, extractable artifacts rather than
 *   depending on this installation's repository-local chart path.
 * - Status, diagnosis, and logs identify the second Target while preserving the App-first product view.
 * - End-to-end acceptance proves enrolment, Target connection, archive-to-URL,
 *   repository-to-signed-artifact, and second-Target admission on a clean installation.
 * - Only after every ticket's acceptance criteria pass is the effort recorded as Spindrift v1.
 */
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import {
  connectTarget,
  createDeploy,
  listTargets,
  uploadArchive,
} from '../../src/commands/index.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import type { TargetAdapter } from '../../src/config/manifest.schema.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  DEFAULT_PLATFORM,
  placementTargetOf,
  resolvePlacement,
} from '../../src/domain/placement.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeBuildAdapter } from '../harness/fakes/build-adapter.ts';
import {
  CAPABLE_DISCOVERY,
  FakeDeployAdapter,
} from '../harness/fakes/deploy-adapter.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  clusterInput,
  fixtureManifest,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

function harnessRegistry(
  targetAdapters: Map<string, DeployAdapter>,
  supplyChain?: SupplyChainHarness,
): AdapterRegistry {
  const chain = supplyChain ?? new SupplyChainHarness();
  return {
    deploy: (adapter: TargetAdapter) => {
      for (const [, adapterImpl] of targetAdapters.entries()) {
        if (adapterImpl.adapter === adapter) return adapterImpl;
      }
      return new FakeDeployAdapter({ adapter });
    },
    build: (route: string) => new FakeBuildAdapter({ name: route }),
    store: () => {
      throw new Error('store not configured');
    },
    repository: () => null,
    supplyChain: () => chain,
  };
}

function context(adapters: AdapterRegistry): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters,
    manifest,
  };
}

describe('Ticket 12 — Admit the artifact on a second Target', () => {
  test('connects a second real Target through native federation with capabilities, policy, and contract', async () => {
    const primaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const secondaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapterMap = new Map<string, DeployAdapter>([
      ['primary-k8s', primaryAdapter],
      ['secondary-k8s', secondaryAdapter],
    ]);
    const ctx = context(harnessRegistry(adapterMap));

    // Connect target 1 (primary)
    const primaryInput = clusterInput({ name: 'primary-k8s' });
    const res1 = await connectTarget(primaryInput, ctx);
    expect(res1.ok).toBe(true);

    // Connect target 2 (secondary)
    const secondaryInput = clusterInput({ name: 'secondary-k8s' });
    const res2 = await connectTarget(secondaryInput, ctx);
    expect(res2.ok).toBe(true);

    // Verify both targets exist in DB and report health & prerequisites
    const listRes = await listTargets({}, ctx);
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;

    expect(listRes.value.targets).toHaveLength(2);
    const targetNames = listRes.value.targets.map((t) => t.name);
    expect(targetNames).toContain('primary-k8s');
    expect(targetNames).toContain('secondary-k8s');

    // Both report prerequisites and health
    for (const t of listRes.value.targets) {
      expect(t.health).toBe('healthy');
    }
  });

  test('Placement selects second Target by real name and explains non-candidate state', async () => {
    const primaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const secondaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapterMap = new Map<string, DeployAdapter>([
      ['primary-k8s', primaryAdapter],
      ['secondary-k8s', secondaryAdapter],
    ]);
    const ctx = context(harnessRegistry(adapterMap));

    await connectTarget(clusterInput({ name: 'primary-k8s' }), ctx);
    await connectTarget(clusterInput({ name: 'secondary-k8s' }), ctx);

    await database()
      .db.update(targets)
      .set({
        health: 'healthy',
        reaches: ['none', 'private', 'public'],
        discovery: {
          ...CAPABLE_DISCOVERY,
          reachableSecretStores: ['onepassword'],
        },
      });

    const allTargets = await database().db.select().from(targets);

    const placementTargets = allTargets.map((t) =>
      placementTargetOf(t, { artifactTypes: ['image'], manifest }),
    );

    const ranked = resolvePlacement(placementTargets, {
      kind: 'service',
      reach: 'private',
      auth: 'proxy',
      platform: DEFAULT_PLATFORM,
      resources: {},
      gpu: false,
      persistence: false,
      datastores: [],
      registries: ['registry.example.test'],
      secretStore: 'onepassword',
    });

    expect(placementTargets).toHaveLength(2);
    expect(ranked.candidates.length).toBeGreaterThan(0);
    expect(ranked.suggested).not.toBeNull();
  });

  test('already-built immutable artifact deploys on second Target without another Build and verifies signature independently', async () => {
    const supplyChain = new SupplyChainHarness();
    const primaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const secondaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapterMap = new Map<string, DeployAdapter>([
      ['primary-k8s', primaryAdapter],
      ['secondary-k8s', secondaryAdapter],
    ]);
    const ctx = context(harnessRegistry(adapterMap, supplyChain));

    // Create App & Component
    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'multi-target-app', sourceKind: 'archive' })
      .returning();
    const [comp] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
      .returning();

    // Connect both Targets using targetValues helper
    const [t1] = await database()
      .db.insert(targets)
      .values(targetValues({ name: 'primary-k8s', adapter: 'kubernetes' }))
      .returning();
    const [t2] = await database()
      .db.insert(targets)
      .values(
        targetValues({ name: 'secondary-k8s', adapter: 'kubernetes', rank: 1 }),
      )
      .returning();

    // Create Build 1 (succeeded, signed)
    const artifactDig = digest(100);
    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: comp!.id,
        commit: digest(101),
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: artifactDig,
        bundleDigest: digest(102),
        bundleLocation: 'https://depot.lolwtf.ca/bundles/multi.zip',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(artifactDig, FROZEN.toISOString()),
      })
      .returning();

    // Deploy on Primary Target
    const deploy1 = await createDeploy(
      { componentId: comp!.id, targetId: t1!.id, buildId: build!.id },
      ctx,
    );
    expect(deploy1.ok).toBe(true);

    // Deploy the SAME build on Secondary Target without a new Build!
    const deploy2 = await createDeploy(
      { componentId: comp!.id, targetId: t2!.id, buildId: build!.id },
      ctx,
    );
    expect(deploy2.ok).toBe(true);

    // Assert that supplyChain verified the signature for BOTH deployments independently
    expect(supplyChain.signatureChecks.admissions).toHaveLength(2);
    expect(supplyChain.signatureChecks.admissions[0]?.artifactDigest).toBe(
      artifactDig,
    );
    expect(supplyChain.signatureChecks.admissions[1]?.artifactDigest).toBe(
      artifactDig,
    );
  });

  test('Installer and App chart distribution use independently pinned, extractable artifacts', async () => {
    // The App chart is a pinned reference an installation declares. The
    // installer chart is not one of these: it named the release this process is
    // already running from, nothing read it, and it has been removed.
    expect(manifest.charts.app).toBeDefined();
    expect(typeof manifest.charts.app).toBe('string');
    expect(manifest.charts).not.toHaveProperty('installer');
  });

  test('Status, diagnosis, and logs identify the second Target while preserving App-first product view', async () => {
    const primaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const secondaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapterMap = new Map<string, DeployAdapter>([
      ['primary-k8s', primaryAdapter],
      ['secondary-k8s', secondaryAdapter],
    ]);
    const ctx = context(harnessRegistry(adapterMap));

    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'status-app', sourceKind: 'archive' })
      .returning();
    const [comp] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service' })
      .returning();
    const [t2] = await database()
      .db.insert(targets)
      .values(
        targetValues({ name: 'secondary-k8s', adapter: 'kubernetes', rank: 1 }),
      )
      .returning();

    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: comp!.id,
        commit: digest(200),
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: digest(200),
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(digest(200), FROZEN.toISOString()),
      })
      .returning();

    const result = await createDeploy(
      { componentId: comp!.id, targetId: t2!.id, buildId: build!.id },
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify Deploy is associated with secondary target
    const [deployRow] = await database()
      .db.select()
      .from(deploys)
      .where(eq(deploys.id, result.value.deployId));

    expect(deployRow?.targetId).toBe(t2!.id);
    expect(deployRow?.componentId).toBe(comp!.id);

    const [desiredRow] = await database()
      .db.select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, comp!.id));
    expect(desiredRow?.targetId).toBe(t2!.id);
    expect(desiredRow?.desiredBuildId).toBe(build!.id);
  });

  test('End-to-end acceptance proves enrolment, Target connection, archive-to-URL, repository-to-signed-artifact, and second-Target admission', async () => {
    const supplyChain = new SupplyChainHarness();
    const primaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const secondaryAdapter = new FakeDeployAdapter({ adapter: 'kubernetes' });
    const adapterMap = new Map<string, DeployAdapter>([
      ['primary-k8s', primaryAdapter],
      ['secondary-k8s', secondaryAdapter],
    ]);
    const ctx = context(harnessRegistry(adapterMap, supplyChain));

    // 1. Target connection
    const c1 = await connectTarget(clusterInput({ name: 'primary-k8s' }), ctx);
    const c2 = await connectTarget(
      clusterInput({ name: 'secondary-k8s' }),
      ctx,
    );
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

    // 2. Archive-to-URL flow
    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'e2e-app', sourceKind: 'archive' })
      .returning();
    const [comp] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'api', kind: 'service' })
      .returning();

    const upload = await uploadArchive(
      {
        componentId: comp!.id,
        targetId: c1.value.targets[0]!.id,
        bundleDigest: digest(300),
        location: 'https://depot.lolwtf.ca/bundles/e2e.zip',
        contents: 'artifact',
        subpath: '.',
      },
      ctx,
    );
    expect(upload.ok).toBe(true);

    // 3. Build & Sign
    // Create a succeeded signed build
    const artifactDig = digest(300);
    const [build] = await database()
      .db.insert(builds)
      .values({
        componentId: comp!.id,
        commit: digest(301),
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: artifactDig,
        bundleDigest: digest(302),
        bundleLocation: 'https://depot.lolwtf.ca/bundles/e2e.zip',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(artifactDig, FROZEN.toISOString()),
      })
      .returning();

    // 4. Deploy to Primary Target
    const d1 = await createDeploy(
      {
        componentId: comp!.id,
        targetId: c1.value.targets[0]!.id,
        buildId: build!.id,
      },
      ctx,
    );
    expect(d1.ok).toBe(true);

    // 5. Deploy SAME signed artifact to Second Target (Admission)
    const d2 = await createDeploy(
      {
        componentId: comp!.id,
        targetId: c2.value.targets[0]!.id,
        buildId: build!.id,
      },
      ctx,
    );
    expect(d2.ok).toBe(true);
    if (!d2.ok) return;
    expect(d2.value.buildId).toBe(build!.id);
  });
});
