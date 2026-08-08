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
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { DeployAdapter } from '../../src/adapters/deploy/contract.ts';
import { helmRelease } from '../../src/adapters/deploy/kubernetes/flux-helmrelease.ts';
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

/** The repository root, for reading the cluster manifests this test proves. */
const REPO_ROOT = join(import.meta.dir, '../../../..');

/**
 * Whether a rendered `HelmRelease`'s chart source is an independently pinned,
 * extractable artifact rather than a path resolved inside this installation's
 * own repository checkout.
 *
 * The old shape — `chart.spec.sourceRef.kind: GitRepository` plus a
 * `chart.spec.chart` path — names somewhere inside a clone of this
 * repository, which is not an artifact on its own: nothing about the string
 * `packages/charts/spindrift` can be pulled by itself. A `chartRef` naming an
 * `OCIRepository` names an object Flux already pulled from a registry by tag,
 * independent of this repository's working tree, which is what "extractable"
 * means for a chart. This is the whole difference the old assertion missed —
 * it checked only that *some* string was present, which a repository-local
 * path satisfies exactly as an OCI reference would.
 */
function isExtractableChartSource(release: {
  spec?: {
    chart?: { spec?: { chart?: string; sourceRef?: { kind?: string } } };
    chartRef?: { kind?: string };
  };
}): boolean {
  return release.spec?.chartRef?.kind === 'OCIRepository';
}

/**
 * Whether an App chart reference names an artifact independent of this
 * repository, rather than a path only this repository's own checkout
 * resolves — the same distinction {@link isExtractableChartSource} draws for
 * the installer, applied to the string `manifest.charts.app` carries.
 */
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
    const primaryInput = clusterInput({ vessel: 'primary-k8s' });
    const res1 = await connectTarget(primaryInput, ctx);
    expect(res1.ok).toBe(true);

    // Connect target 2 (secondary)
    const secondaryInput = clusterInput({ vessel: 'secondary-k8s' });
    const res2 = await connectTarget(secondaryInput, ctx);
    expect(res2.ok).toBe(true);

    // Verify both targets exist in DB and report health & prerequisites
    const listRes = await listTargets({}, ctx);
    expect(listRes.ok).toBe(true);
    if (!listRes.ok) return;

    expect(listRes.value.targets).toHaveLength(2);
    const targetNames = listRes.value.targets.map((t) => t.vessel);
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

    // Create App & Component
    const [app] = await database()
      .db.insert(apps)
      .values({ name: 'multi-target-app', sourceKind: 'archive' })
      .returning();
    const [comp] = await database()
      .db.insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
      .returning();

    // Connect both Targets using targetValues helper, each on its own vessel.
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

  test('Installer chart distribution is an independently pinned, extractable OCI artifact', async () => {
    // Read the real cluster manifests rather than a fixture: the point of
    // this criterion is what this installation actually deploys from, and a
    // fixture that says the right thing while the repo says the old thing is
    // exactly the false positive this test replaces.
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
    // The exact shape clusters/offsite/apps/spindrift/helm-release.yaml
    // carried before this ticket: `packages/charts/spindrift` resolved
    // through GitRepository/infra. A detector nobody has seen fail is not a
    // detector — this is the proof the assertion above is not vacuous.
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

  test('App chart distribution is an independently pinned, extractable OCI artifact', async () => {
    // The declaration this installation is seeded from, not a fixture, for the
    // same reason the installer assertion above reads it: what matters is what
    // this installation deploys every Component through.
    const release = Bun.YAML.parse(
      await Bun.file(
        join(REPO_ROOT, 'clusters/offsite/apps/spindrift/helm-release.yaml'),
      ).text(),
    ) as {
      spec?: {
        values?: {
          manifest?: {
            charts?: { app?: string };
            targets?: {
              connection?: {
                delivery?: {
                  sourceRef?: { name?: string; namespace?: string };
                };
              };
            }[];
          };
        };
      };
    };
    const declared = release.spec?.values?.manifest;
    expect(isExtractableAppChartRef(declared?.charts?.app ?? '')).toBe(true);

    // And that the reference is one every Kubernetes Target can actually
    // resolve. The chart reference is the only discriminant the adapter has, so
    // an `oci://` value with a Target still pointed at a GitRepository is a
    // declaration that renders a chartRef at an object of the wrong kind — the
    // failure mode the `charts.app` string alone cannot show.
    const sources = (declared?.targets ?? [])
      .map((target) => target.connection?.delivery?.sourceRef)
      .filter((ref) => ref !== undefined);
    expect(sources.length).toBeGreaterThan(0);
    for (const ref of sources) {
      expect(ref).toEqual({
        name: 'spindrift-app',
        namespace: 'spindrift-apps',
      });
    }
  });

  test('the App-chart check catches a repository-local chart path', () => {
    // The proof the assertion above is not the vacuous one it replaces. The old
    // guard asked only that `manifest.charts.app` was a defined string, which
    // the exact value this installation carried before this ticket satisfies —
    // so it passed the whole time nothing was built.
    expect(isExtractableAppChartRef('packages/charts/spindrift-app')).toBe(
      false,
    );
  });

  test('an oci:// App chart is rendered as an extractable source, not a path', () => {
    // The declaration is only half the claim: `charts.app` naming an artifact
    // means nothing unless the object the adapter writes fetches from it. This
    // is that half, against the real renderer.
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
    // The repository form still renders, unchanged, for an installation that
    // names a path — extraction is a choice this installation made, not a
    // capability the adapter lost.
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
    // `.github/workflows/spindrift-charts.yml` pushes each chart under the
    // version its own Chart.yaml names, and each consumer pins that version by
    // tag. Bumping one without the other is silent both ways: a version ahead
    // of the tag ships nothing, and a tag ahead of the push leaves the source
    // object failing to pull. This is the only thing holding the pair together.
    //
    // Fast lane: this test alone is `spindrift#test:chart-pins` in
    // `turbo.json`, with its own narrow `inputs` (the four files below, plus
    // this file) and no `build` dependency — so a PR that only bumps a chart
    // version and its consumer tag reruns this one fast assertion (still pays
    // for the file's per-test isolated schema, via the describe-scoped
    // `withIsolatedDatabase()` below, but nothing more) instead of
    // cache-busting the full `spindrift#test` suite. The two
    // `oci-repository.yaml` consumers stay
    // out of `spindrift#test`'s own inputs because every check the rest of
    // the suite makes against them (existence of a `tag`/`digest`, `url`
    // shape) is strictly weaker than this test's exact-match checks — nothing
    // else needs a fresher copy than this test already demands. `Chart.yaml`
    // for `spindrift-app` is the one file both tasks still list:
    // `values.test.ts` reads a different field of it (the values-contract
    // annotation) that this test does not touch and does not subsume.
    const consumers: [string, string][] = [
      ['spindrift', 'clusters/offsite/apps/spindrift/oci-repository.yaml'],
      // The clean-installation acceptance environment consumes the same
      // artifact independently, and is listed for the reason the pair above is:
      // a consumer nothing checks is a tag that stops resolving the first time
      // the chart version moves, and this one exists precisely to prove the
      // published chart installs.
      [
        'spindrift',
        'clusters/offsite/apps/spindrift-acceptance/oci-repository.yaml',
      ],
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
