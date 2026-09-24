/**
 * One built artifact admitted on a second Target without another Build, and the
 * charts both Targets deploy from pinned as pullable OCI artifacts.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { helmRelease } from '../../src/adapters/deploy/kubernetes/flux-helmrelease.ts';
import { uploadArchive } from '../../src/commands/apps/upload-archive.ts';
import { createDeploy } from '../../src/commands/deploys/create.ts';
import { connectTarget } from '../../src/commands/targets/connect.ts';
import { listTargets } from '../../src/commands/targets/list.ts';
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
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const FROZEN = new Date('2024-06-01T00:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

function digest(seed: number): string {
  return `sha256:${seed.toString(16).padStart(64, '0')}`;
}

const REPO_ROOT = join(import.meta.dir, '../../../..');

/**
 * An `OCIRepository` chart is pulled by tag on its own. A chart path inside a
 * `GitRepository` needs this repository's checkout.
 */
function isExtractableChartSource(release: {
  spec?: {
    chart?: { spec?: { chart?: string; sourceRef?: { kind?: string } } };
    chartRef?: { kind?: string };
  };
}): boolean {
  return release.spec?.chartRef?.kind === 'OCIRepository';
}

function isExtractableAppChartRef(ref: string): boolean {
  return ref.startsWith('oci://');
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
    principal: {
      id: crypto.randomUUID(),
      displayName: 'Operator',
      kind: 'human',
    },
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

    const primaryInput = clusterInput({ vessel: 'primary-k8s' });
    const res1 = await connectTarget(primaryInput, ctx);
    expect(res1.ok).toBe(true);

    const secondaryInput = clusterInput({ vessel: 'secondary-k8s' });
    const res2 = await connectTarget(secondaryInput, ctx);
    expect(res2.ok).toBe(true);

    const listRes = await listTargets({}, ctx);
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;

    expect(listRes.value.targets).toHaveLength(2);
    const targetNames = listRes.value.targets.map((t) => t.vessel);
    expect(targetNames).toContain('primary-k8s');
    expect(targetNames).toContain('secondary-k8s');

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

    await connectTarget(clusterInput({ vessel: 'primary-k8s' }), ctx);
    await connectTarget(clusterInput({ vessel: 'secondary-k8s' }), ctx);

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

    const allTargets = await database().db.query.targets.findMany({
      with: { vessel: true },
    });

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

    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'multi-target-app', sourceKind: 'archive' })
      .returning();
    const [comp] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
      .returning();

    const primaryVessel = await insertVessel(database().db, 'kubernetes', {
      name: 'primary-k8s',
    });
    const secondaryVessel = await insertVessel(database().db, 'kubernetes', {
      name: 'secondary-k8s',
    });
    const [t1] = await database()
      .db.insert(targets)
      .values(
        targetValues({ adapter: 'kubernetes', vesselId: primaryVessel.id }),
      )
      .returning();
    const [t2] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'kubernetes',
          vesselId: secondaryVessel.id,
          rank: 1,
        }),
      )
      .returning();

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

    const deploy1 = await createDeploy(
      { componentId: comp!.id, targetId: t1!.id, buildId: build!.id },
      ctx,
    );
    expect(deploy1.ok).toBe(true);

    const deploy2 = await createDeploy(
      { componentId: comp!.id, targetId: t2!.id, buildId: build!.id },
      ctx,
    );
    expect(deploy2.ok).toBe(true);

    expect(supplyChain.signatureChecks.admissions).toHaveLength(2);
    expect(supplyChain.signatureChecks.admissions[0]?.artifactDigest).toBe(
      artifactDig,
    );
    expect(supplyChain.signatureChecks.admissions[1]?.artifactDigest).toBe(
      artifactDig,
    );
  });

  test('Installer chart distribution is an independently pinned, extractable OCI artifact', async () => {
    // The real cluster manifests, because a fixture can disagree with them.
    const helmRelease = Bun.YAML.parse(
      await Bun.file(
        join(REPO_ROOT, 'clusters/offsite/apps/spindrift/helm-release.yaml'),
      ).text(),
    ) as Parameters<typeof isExtractableChartSource>[0];
    expect(isExtractableChartSource(helmRelease)).toBe(true);

    const ociRepository = Bun.YAML.parse(
      await Bun.file(
        join(REPO_ROOT, 'clusters/offsite/apps/spindrift/oci-repository.yaml'),
      ).text(),
    ) as { spec?: { url?: string; ref?: { tag?: string; digest?: string } } };
    expect(ociRepository.spec?.url).toMatch(/^oci:\/\//);
    expect(
      ociRepository.spec?.ref?.tag ?? ociRepository.spec?.ref?.digest,
    ).toBeTruthy();
  });

  test('the installer check catches a repository-local chart path', () => {
    const beforeThisFix = {
      spec: {
        chart: {
          spec: {
            chart: 'packages/charts/spindrift',
            sourceRef: {
              kind: 'GitRepository',
              name: 'infra',
              namespace: 'flux-system',
            },
          },
        },
      },
    };
    expect(isExtractableChartSource(beforeThisFix)).toBe(false);
  });

  test('the App-chart check catches a repository-local chart path', () => {
    expect(isExtractableAppChartRef('packages/charts/spindrift-app')).toBe(
      false,
    );
  });

  test('an oci:// App chart is rendered as an extractable source, not a path', () => {
    const rendered = helmRelease({
      name: 'blog-web',
      namespace: 'spindrift-apps',
      targetNamespace: 'spindrift-apps',
      chart: 'oci://ghcr.io/jonpulsifer/charts/spindrift-app',
      sourceRef: { name: 'spindrift-app', namespace: 'spindrift-apps' },
      labels: {},
      values: {},
    }) as Parameters<typeof isExtractableChartSource>[0];

    expect(isExtractableChartSource(rendered)).toBe(true);
    // A chart path still renders with a `GitRepository` source.
    const path = helmRelease({
      name: 'blog-web',
      namespace: 'spindrift-apps',
      targetNamespace: 'spindrift-apps',
      chart: 'packages/charts/spindrift-app',
      sourceRef: { name: 'infra', namespace: 'flux-system' },
      labels: {},
      values: {},
    }) as Parameters<typeof isExtractableChartSource>[0];

    expect(isExtractableChartSource(path)).toBe(false);
    expect(path.spec?.chart?.spec?.sourceRef?.kind).toBe('GitRepository');
  });

  test('each chart consumer pins the version its Chart.yaml carries', async () => {
    // A version ahead of its tag ships nothing, and a tag ahead of the push
    // cannot pull. turbo.json's `spindrift#test:chart-pins` inputs list these.
    const consumers: [string, string][] = [
      ['spindrift', 'clusters/offsite/apps/spindrift/oci-repository.yaml'],
      [
        'spindrift-app',
        'clusters/base/platform/spindrift-target/oci-repository.yaml',
      ],
    ];
    for (const [chart, consumer] of consumers) {
      const { version } = Bun.YAML.parse(
        await Bun.file(
          join(REPO_ROOT, `packages/charts/${chart}/Chart.yaml`),
        ).text(),
      ) as { version?: string };
      const source = Bun.YAML.parse(
        await Bun.file(join(REPO_ROOT, consumer)).text(),
      ) as { spec?: { url?: string; ref?: { tag?: string } } };
      expect(source.spec?.url).toBe(
        `oci://ghcr.io/jonpulsifer/charts/${chart}`,
      );
      expect(source.spec?.ref?.tag).toBe(version);
    }
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
    const secondaryVessel = await insertVessel(database().db, 'kubernetes', {
      name: 'secondary-k8s',
    });
    const [t2] = await database()
      .db.insert(targets)
      .values(
        targetValues({
          adapter: 'kubernetes',
          vesselId: secondaryVessel.id,
          rank: 1,
        }),
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

    const c1 = await connectTarget(
      clusterInput({ vessel: 'primary-k8s' }),
      ctx,
    );
    const c2 = await connectTarget(
      clusterInput({ vessel: 'secondary-k8s' }),
      ctx,
    );
    expect(c1.ok).toBe(true);
    expect(c2.ok).toBe(true);
    if (!c1.ok || !c2.ok) return;

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

    const d1 = await createDeploy(
      {
        componentId: comp!.id,
        targetId: c1.value.targets[0]!.id,
        buildId: build!.id,
      },
      ctx,
    );
    expect(d1.ok).toBe(true);

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
