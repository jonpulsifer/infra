import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type {
  AuthoredManifest,
  InstallationManifest,
  TargetAdapter,
} from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  ManifestError,
  parseManifest,
  UNSERVED_HOSTNAME,
} from '../../src/config/manifest.ts';
import {
  diffManifestPaths,
  loadStoredManifest,
  targetConnectionDivergence,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import { createDb } from '../../src/db/client.ts';
import { installation, targets, vessels } from '../../src/db/schema.ts';
import { zoneFor } from '../../src/domain/naming.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  connectionFor,
  FIXTURE_DEPLOYMENT_ENV,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();

async function targetIdOf(
  vessel: string,
  adapter: TargetAdapter = 'kubernetes',
): Promise<string> {
  const [row] = await database()
    .db.select({ id: targets.id })
    .from(targets)
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(and(eq(vessels.name, vessel), eq(targets.adapter, adapter)));
  return row!.id;
}
const FIXTURE = new URL(
  '../fixtures/installation.example.yaml',
  import.meta.url,
);
const fixtureText = await Bun.file(FIXTURE).text();
const fixtureManifest = Bun.YAML.parse(fixtureText) as AuthoredManifest;
const connectedManifest = {
  ...fixtureManifest,
  vessels: [
    {
      name: 'cluster',
      kind: 'cluster',
      location: { apiServer: 'https://cluster.example.test' },
    },
    {
      name: 'cloud',
      kind: 'gcp-project',
      // The optional network, so the round-trip below covers it.
      location: {
        project: 'example-vessel',
        network: { name: 'example-network', region: 'example-region' },
      },
      // Only the home vessel may carry `shared`, so take the fixture's.
      shared: fixtureManifest.vessels.find(
        (vessel) => vessel.name === fixtureManifest.installation.homeVessel,
      )?.shared,
    },
  ],
  targets: [
    {
      vessel: 'cluster',
      adapter: 'kubernetes',
      connection: {
        namespace: 'apps',
        delivery: {
          flavour: 'flux-helmrelease',
          namespace: 'apps',
          sourceRef: { name: 'infra', namespace: 'flux-system' },
        },
      },
    },
    {
      vessel: 'cloud',
      adapter: 'cloudrun',
      connection: {
        region: 'example-region',
        endpoint: 'https://run.example.test',
      },
    },
    {
      vessel: 'cloud',
      adapter: 'static',
      connection: {
        endpoint: 'https://hosting.example.test',
      },
    },
  ],
} satisfies AuthoredManifest;

/** Writes the document as a fresh installation's seed, then boots from it. */
async function bootFrom(
  document: AuthoredManifest | string,
): Promise<InstallationManifest> {
  const manifest =
    typeof document === 'string'
      ? parseManifest(document, 'the fixture declaration')
      : document;
  await writeStoredManifest(database().db, manifest);
  return loadStoredManifest(database().db);
}

describe('the stored installation manifest', () => {
  test('stores declared configuration, then boots from the database alone', async () => {
    const first = await bootFrom(fixtureText);
    expect(first.installation.name).toBe('example');

    const later = await loadStoredManifest(database().db);
    expect(later).toEqual(first);
  });

  test('seeds manifest Targets as disconnected rows in manifest rank order', async () => {
    await bootFrom(fixtureText);

    const rows = await database().db.query.targets.findMany({
      with: { vessel: true },
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map(({ vessel, adapter, rank, status, health, connection }) => ({
        vessel: vessel.name,
        adapter,
        rank,
        status,
        health,
        connection,
      })),
    ).toEqual([
      {
        vessel: 'cluster',
        adapter: 'kubernetes',
        rank: 0,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
      {
        vessel: 'cloud',
        adapter: 'cloudrun',
        rank: 1,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
      {
        vessel: 'cloud',
        adapter: 'static',
        rank: 2,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
    ]);
  });

  test('a fresh database reconstructs every declared Target connection', async () => {
    await bootFrom(JSON.stringify(connectedManifest));

    const rows = await database().db.query.targets.findMany({
      with: { vessel: true },
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map(({ vessel, status, connection }) => ({
        vessel: vessel.name,
        status,
        connection,
      })),
    ).toEqual([
      {
        vessel: 'cluster',
        status: 'connected',
        connection: {
          adapter: 'kubernetes',
          namespace: 'apps',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'apps',
            sourceRef: { name: 'infra', namespace: 'flux-system' },
          },
        },
      },
      {
        vessel: 'cloud',
        status: 'connected',
        connection: {
          adapter: 'cloudrun',
          region: 'example-region',
          endpoint: 'https://run.example.test',
        },
      },
      {
        vessel: 'cloud',
        status: 'connected',
        connection: {
          adapter: 'static',
          endpoint: 'https://hosting.example.test',
        },
      },
    ]);

    // Boundary facts are stored once per vessel, and both cloud Targets share
    // one.
    const vesselRows = await database().db.query.vessels.findMany({
      orderBy: (vessels, { asc }) => [asc(vessels.name)],
    });
    expect(
      vesselRows
        // Skip the harness's per-kind fixture vessels.
        .filter((vessel) => !vessel.name.startsWith('fixture-'))
        .map(({ name, kind, location }) => ({ name, kind, location })),
    ).toEqual([
      {
        name: 'cloud',
        kind: 'gcp-project',
        location: {
          kind: 'gcp-project',
          project: 'example-vessel',
          network: { name: 'example-network', region: 'example-region' },
        },
      },
      {
        name: 'cluster',
        kind: 'cluster',
        location: {
          kind: 'cluster',
          apiServer: 'https://cluster.example.test',
        },
      },
    ]);
  });

  test('a changed Target connection resets its assessment and timestamp', async () => {
    await bootFrom(JSON.stringify(connectedManifest));
    const old = new Date('2000-01-01T00:00:00.000Z');
    await database()
      .db.update(targets)
      .set({ health: 'healthy', updatedAt: old })
      .where(eq(targets.id, await targetIdOf('cluster')));
    const changed = {
      ...connectedManifest,
      vessels: connectedManifest.vessels.map((vessel) =>
        vessel.kind === 'cluster'
          ? {
              ...vessel,
              location: { apiServer: 'https://replacement.example.test' },
            }
          : vessel,
      ),
    } satisfies AuthoredManifest;

    // Written through writeStoredManifest, since a boot writes the row back
    // without reconciling the changed connection.
    await writeStoredManifest(database().db, changed);

    const cluster = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    // The address lives on the vessel, and its Target is still reassessed.
    const clusterVessel = await database().db.query.vessels.findFirst({
      where: (vessels, { eq }) => eq(vessels.name, 'cluster'),
    });
    expect(clusterVessel?.location).toEqual({
      kind: 'cluster',
      apiServer: 'https://replacement.example.test',
    });
    expect(cluster?.health).toBe('unhealthy');
    expect(cluster?.inspectedAt).toBeNull();
    expect(cluster?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  test('a boot leaves an operator’s Target connection alone, and says where it diverges', async () => {
    await bootFrom(JSON.stringify(connectedManifest));

    // What `connectTarget` writes: the row only, while the manifest keeps the
    // old value.
    const corrected = {
      adapter: 'kubernetes' as const,
      // No `apiServer`: the cluster's address belongs to its vessel.
      namespace: 'apps',
      delivery: {
        flavour: 'flux-helmrelease' as const,
        namespace: 'apps',
        sourceRef: { name: 'infra', namespace: 'flux-system' },
      },
      chartValues: {
        platform: {
          gateway: { name: 'spindrift-apps', namespace: 'spindrift-apps' },
        },
      },
    };
    await database()
      .db.update(targets)
      .set({ connection: corrected, health: 'healthy' })
      .where(eq(targets.id, await targetIdOf('cluster')));

    // A restart: `loadStoredManifest` writes the stored document back on every
    // boot.
    await loadStoredManifest(database().db);

    const cluster = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(cluster?.connection).toEqual(corrected);
    // A boot declares nothing, so the assessment stands.
    expect(cluster?.health).toBe('healthy');

    // Submitting the document in Settings would revert the row, so the
    // divergence is reported.
    expect(
      targetConnectionDivergence(
        connectedManifest.targets[0],
        cluster?.connection ?? null,
      ),
    ).toEqual(['connection.chartValues']);
  });

  test('a Target the manifest declares no connection for never diverges', async () => {
    // A seed may leave the connection to the product, so the row has nothing to
    // diverge from.
    await bootFrom(fixtureText);
    await database()
      .db.update(targets)
      .set({ connection: connectionFor('kubernetes'), status: 'connected' })
      .where(eq(targets.id, await targetIdOf('cluster')));

    const cluster = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(
      targetConnectionDivergence(
        fixtureManifest.targets.find((target) => target.vessel === 'cluster'),
        cluster?.connection ?? null,
      ),
    ).toEqual([]);
  });

  test('a later write replaces what the row held', async () => {
    const first = await bootFrom(fixtureText);
    expect(first.installation.name).toBe('example');

    const later = await bootFrom(
      fixtureText.replace('name: example', 'name: replacement'),
    );
    expect(later.installation.name).toBe('replacement');
    expect(await loadStoredManifest(database().db)).toEqual(later);
  });

  test('updating declared configuration preserves connected Target state', async () => {
    await bootFrom(fixtureText);
    const before = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    await database()
      .db.update(targets)
      .set({
        status: 'connected',
        connection: {
          adapter: 'kubernetes',
          namespace: 'apps',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'apps',
            sourceRef: { name: 'infra', namespace: 'flux-system' },
          },
        },
      })
      .where(eq(targets.id, await targetIdOf('cluster')));

    const changed = fixtureText.replace('name: example', 'name: replacement');
    await bootFrom(changed);

    const after = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe('connected');
    expect(after?.connection).toEqual({
      adapter: 'kubernetes',
      namespace: 'apps',
      delivery: {
        flavour: 'flux-helmrelease',
        namespace: 'apps',
        sourceRef: { name: 'infra', namespace: 'flux-system' },
      },
    });
  });

  test('an invalid declaration does not overwrite durable configuration', async () => {
    const first = await bootFrom(fixtureText);
    const malformed = fixtureText.replace(
      'installation: example',
      'installation: ""',
    );

    expect(await bootFrom(malformed)).toEqual(first);

    expect(await loadStoredManifest(database().db)).toEqual(first);
  });

  test('a declaration this build cannot parse does not stop a seeded boot', async () => {
    const first = await bootFrom(fixtureText);
    const fromTheFuture = fixtureText.replace(
      'installation: example',
      'installation: example\nsomethingThisBuildHasNeverHeardOf: true',
    );

    expect(await bootFrom(fromTheFuture)).toEqual(first);
  });

  test('an unseeded installation still refuses to boot on a bad declaration', async () => {
    await expect(
      bootFrom(fixtureText.replace('name: example', 'name: ""')),
    ).rejects.toThrow(ManifestError);
  });

  test('a stored row this build cannot parse re-seeds from the declaration', async () => {
    await bootFrom(fixtureText);
    await database()
      .db.update(installation)
      .set({
        manifest: {
          ...fixtureManifest,
          dns: { apexZone: 'apps.example.test', vanityZone: 'example.test' },
        } as unknown as AuthoredManifest,
      });

    const booted = await bootFrom(fixtureText);
    expect(zoneFor('private', booted.dns.zones)).toBe('apps.example.test');

    // A row no upgrade can read fails the boot.
    await database()
      .db.update(installation)
      .set({
        manifest: { installation: 'broken' } as unknown as AuthoredManifest,
      });
    await expect(loadStoredManifest(database().db)).rejects.toThrow(
      ManifestError,
    );
  });

  test('a declared write updates an existing Target’s asserted reaches, and a boot does not', async () => {
    await bootFrom(JSON.stringify(connectedManifest));
    const seeded = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    // No declared reach, so the row asserts none.
    expect(seeded?.reaches).toBeNull();

    const [cluster, ...rest] = connectedManifest.targets;
    const asserting = {
      ...connectedManifest,
      targets: [
        {
          ...cluster!,
          reaches: ['none', 'private', 'public'],
          authReaches: ['private'],
        },
        ...rest,
      ],
    } as AuthoredManifest;
    await writeStoredManifest(database().db, asserting);

    const declared = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(declared?.reaches).toEqual(['none', 'private', 'public']);
    expect(declared?.authReaches).toEqual(['private']);

    // A boot declares nothing, so it keeps a reach the operator set on the row.
    await database()
      .db.update(targets)
      .set({ reaches: ['none'] })
      .where(eq(targets.id, await targetIdOf('cluster')));
    await writeStoredManifest(database().db, asserting, 'booted');

    const booted = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(booted?.reaches).toEqual(['none']);
  });

  test('repairs a stored Target rank from manifest order', async () => {
    await bootFrom(fixtureText);
    await database()
      .db.update(targets)
      .set({ rank: 99 })
      .where(eq(targets.id, await targetIdOf('cluster')));

    await loadStoredManifest(database().db);

    const cluster = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    expect(cluster?.rank).toBe(0);
  });

  test('simultaneous processes converge on one row', async () => {
    const contender = createDb(database().connect());
    await writeStoredManifest(database().db, fixtureManifest);
    const [first, second] = await Promise.all([
      loadStoredManifest(database().db),
      loadStoredManifest(contender),
    ]);
    expect(second).toEqual(first);
    expect(first.installation.name).toBe('example');
    expect(await database().db.select().from(targets)).toHaveLength(3);
  });

  test('the database enforces that there is only one installation', async () => {
    await database()
      .db.insert(installation)
      .values({ manifest: fixtureManifest });

    await expect(
      Promise.resolve(
        database()
          .db.insert(installation)
          .values({ id: 2, manifest: fixtureManifest }),
      ),
    ).rejects.toThrow();
  });

  test('fails closed when the stored document is malformed', async () => {
    const malformed = JSON.stringify({ installation: 'broken' });
    await database().client`
      INSERT INTO installation (manifest)
      VALUES (${malformed}::jsonb)
    `;

    await expect(loadStoredManifest(database().db)).rejects.toThrow(
      /database installation manifest/,
    );
  });

  test('seeds default placeholder manifest when the database is empty and no bootstrap exists', async () => {
    const loaded = await loadStoredManifest(database().db);
    // The placeholder, plus the deployment facts an empty environment resolves.
    expect(loaded).toEqual({
      ...DEFAULT_PLACEHOLDER_MANIFEST,
      cloud: { federation: null },
      boundary: { trustedGateway: false },
      controlPlane: {
        hostname: UNSERVED_HOSTNAME,
        publicHostname: null,
        reservedHostnames: [],
        version: null,
      },
    });
  });

  test('a row restating a fact the deployment declares is refused', async () => {
    // The schema is strict, so a key the deployment owns is refused from
    // storage too.
    await database().client`
      INSERT INTO installation (manifest)
      VALUES (${JSON.stringify({
        ...fixtureManifest,
        charts: { ...fixtureManifest.charts, installer: 'example/spindrift' },
      })}::jsonb)
    `;

    expect(
      loadStoredManifest(database().db, FIXTURE_DEPLOYMENT_ENV),
    ).rejects.toThrow(/installer/);
  });
});

describe('naming where two documents disagree', () => {
  test('an identical document reports no divergence', () => {
    expect(diffManifestPaths(connectedManifest, connectedManifest)).toEqual([]);
  });

  test('names the dotted paths that differ, and only those', () => {
    // Only a gateway nested in one Target's connection differs.
    const withGateway = (name: string, namespace: string) => ({
      ...connectedManifest,
      targets: connectedManifest.targets.map((target) =>
        target.adapter === 'kubernetes'
          ? {
              ...target,
              connection: {
                ...target.connection,
                chartValues: { platform: { gateway: { name, namespace } } },
              },
            }
          : target,
      ),
    });
    const declared = withGateway(
      'spindrift-apps',
      'spindrift-apps',
    ) satisfies AuthoredManifest;
    const stored = withGateway(
      'cluster-gateway',
      'cluster-gateway',
    ) satisfies AuthoredManifest;

    expect(diffManifestPaths(declared, stored)).toEqual([
      'targets.0.connection.chartValues.platform.gateway.name',
      'targets.0.connection.chartValues.platform.gateway.namespace',
    ]);
  });

  test('the report carries the path that differs, never the values', () => {
    const stored = {
      ...connectedManifest,
      vessels: connectedManifest.vessels.map((vessel) =>
        vessel.kind === 'cluster'
          ? {
              ...vessel,
              location: { apiServer: 'https://replacement.example.test' },
            }
          : vessel,
      ),
    } satisfies AuthoredManifest;

    const paths = diffManifestPaths(connectedManifest, stored);
    expect(paths).toEqual(['vessels.0.location.apiServer']);
    // Paths only, so a credential in a future connection field never reaches a
    // log line.
    const rendered = JSON.stringify(paths);
    expect(rendered).not.toContain('cluster.example.test');
    expect(rendered).not.toContain('replacement.example.test');
  });
});
