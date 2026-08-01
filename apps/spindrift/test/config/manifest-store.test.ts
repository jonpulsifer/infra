import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  MANIFEST_INLINE_VAR,
  ManifestError,
} from '../../src/config/manifest.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import { createDb } from '../../src/db/client.ts';
import { installation, targets } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FIXTURE_DEPLOYMENT_ENV } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const FIXTURE = new URL(
  '../fixtures/installation.example.yaml',
  import.meta.url,
);
const fixtureText = await Bun.file(FIXTURE).text();
const fixtureManifest = Bun.YAML.parse(fixtureText) as AuthoredManifest;
const connectedManifest = {
  ...fixtureManifest,
  targets: [
    {
      name: 'cluster',
      adapter: 'kubernetes',
      connection: {
        apiServer: 'https://cluster.example.test',
        namespace: 'apps',
        delivery: {
          flavour: 'flux-helmrelease',
          namespace: 'apps',
          sourceRef: { name: 'infra', namespace: 'flux-system' },
        },
        chartContract: '2',
      },
    },
    {
      name: 'cloud-cloudrun',
      adapter: 'cloudrun',
      connection: {
        project: 'example-vessel',
        region: 'example-region',
        endpoint: 'https://run.example.test',
      },
    },
    {
      name: 'cloud-static',
      adapter: 'static',
      connection: {
        project: 'example-vessel',
        endpoint: 'https://hosting.example.test',
      },
    },
  ],
} satisfies AuthoredManifest;

describe('the stored installation manifest', () => {
  test('stores declared configuration, then boots from the database alone', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(first.installation).toBe('example');

    const later = await loadStoredManifest(database().db, {});
    expect(later).toEqual(first);
  });

  test('seeds manifest Targets as disconnected rows in manifest rank order', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });

    const rows = await database().db.query.targets.findMany({
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map(({ name, adapter, rank, status, health, connection }) => ({
        name,
        adapter,
        rank,
        status,
        health,
        connection,
      })),
    ).toEqual([
      {
        name: 'cluster',
        adapter: 'kubernetes',
        rank: 0,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
      {
        name: 'cloud-cloudrun',
        adapter: 'cloudrun',
        rank: 1,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
      {
        name: 'cloud-static',
        adapter: 'static',
        rank: 2,
        status: 'disconnected',
        health: 'unhealthy',
        connection: null,
      },
    ]);
  });

  test('a fresh database reconstructs every declared Target connection', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });

    const rows = await database().db.query.targets.findMany({
      orderBy: (targets, { asc }) => [asc(targets.rank)],
    });
    expect(
      rows.map(({ name, status, connection }) => ({
        name,
        status,
        connection,
      })),
    ).toEqual([
      {
        name: 'cluster',
        status: 'connected',
        connection: {
          adapter: 'kubernetes',
          apiServer: 'https://cluster.example.test',
          namespace: 'apps',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'apps',
            sourceRef: { name: 'infra', namespace: 'flux-system' },
          },
          chartContract: '2',
        },
      },
      {
        name: 'cloud-cloudrun',
        status: 'connected',
        connection: {
          adapter: 'cloudrun',
          project: 'example-vessel',
          region: 'example-region',
          endpoint: 'https://run.example.test',
        },
      },
      {
        name: 'cloud-static',
        status: 'connected',
        connection: {
          adapter: 'static',
          project: 'example-vessel',
          endpoint: 'https://hosting.example.test',
        },
      },
    ]);
  });

  test('a changed Target connection resets its assessment and timestamp', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });
    const old = new Date('2000-01-01T00:00:00.000Z');
    await database()
      .db.update(targets)
      .set({ health: 'healthy', updatedAt: old })
      .where(eq(targets.name, 'cluster'));
    const changed = {
      ...connectedManifest,
      targets: connectedManifest.targets.map((target) =>
        target.adapter === 'kubernetes'
          ? {
              ...target,
              connection: {
                ...target.connection,
                apiServer: 'https://replacement.example.test',
              },
            }
          : target,
      ),
    } satisfies AuthoredManifest;

    // Configuration is the UI's to drive, so the trigger for reconciliation is
    // the stored manifest changing — which is what a settings write is.
    await database().db.update(installation).set({ manifest: changed });
    await loadStoredManifest(database().db, {});

    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(cluster?.connection).toMatchObject({
      apiServer: 'https://replacement.example.test',
    });
    expect(cluster?.health).toBe('unhealthy');
    expect(cluster?.inspectedAt).toBeNull();
    expect(cluster?.updatedAt.getTime()).toBeGreaterThan(old.getTime());
  });

  test('a declaration seeds an empty installation and never governs a seeded one', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(first.installation).toBe('example');
    const changed = fixtureText.replace(
      'installation: example',
      'installation: replacement',
    );

    // A rollout must not revert what an operator just configured, so the row
    // wins over the declaration that seeded it.
    const later = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });
    expect(later).toEqual(first);
    expect(later.installation).toBe('example');
  });

  test('discarding the row re-seeds from the declaration', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const changed = fixtureText.replace(
      'installation: example',
      'installation: replacement',
    );

    // The deliberate act that makes a declaration apply again. It is also the
    // whole of the tear-down-and-redeploy loop: an installation that lost its
    // database comes back configured without anyone opening a browser.
    await database().db.delete(installation);

    const reseeded = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });
    expect(reseeded.installation).toBe('replacement');
    expect(await loadStoredManifest(database().db, {})).toEqual(reseeded);
  });

  test('updating declared configuration preserves connected Target state', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const before = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    await database()
      .db.update(targets)
      .set({
        status: 'connected',
        connection: {
          adapter: 'kubernetes',
          apiServer: 'https://cluster.example.test',
          namespace: 'apps',
          delivery: {
            flavour: 'flux-helmrelease',
            namespace: 'apps',
            sourceRef: { name: 'infra', namespace: 'flux-system' },
          },
        },
      })
      .where(eq(targets.name, 'cluster'));

    const changed = fixtureText.replace(
      'installation: example',
      'installation: replacement',
    );
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });

    const after = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(after?.id).toBe(before?.id);
    expect(after?.status).toBe('connected');
    expect(after?.connection).toEqual({
      adapter: 'kubernetes',
      apiServer: 'https://cluster.example.test',
      namespace: 'apps',
      delivery: {
        flavour: 'flux-helmrelease',
        namespace: 'apps',
        sourceRef: { name: 'infra', namespace: 'flux-system' },
      },
    });
  });

  test('an invalid declaration does not overwrite durable configuration', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const malformed = fixtureText.replace(
      'installation: example',
      'installation: ""',
    );

    await expect(
      loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: malformed,
      }),
    ).rejects.toThrow(ManifestError);

    expect(await loadStoredManifest(database().db, {})).toEqual(first);
  });

  test('an incompatible Target declaration rolls back manifest and rank changes', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    await database()
      .db.update(targets)
      .set({ rank: 99 })
      .where(eq(targets.name, 'cluster'));
    // Re-seeding is where a declaration can still meet Target rows it did not
    // create: discarding the installation row leaves the Targets behind.
    await database().db.delete(installation);
    const incompatible = {
      ...fixtureManifest,
      installation: 'incompatible',
      targets: [
        { name: 'cluster', adapter: 'kubernetes' },
        { name: 'cloud-cloudrun', adapter: 'kubernetes' },
      ],
    } satisfies AuthoredManifest;

    await expect(
      loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: JSON.stringify(incompatible),
      }),
    ).rejects.toThrow(/stored Target uses cloudrun/);

    // The whole seed is one transaction, so a refused Target leaves no
    // half-seeded installation behind and no rank change from the attempt.
    expect(await database().db.select().from(installation)).toEqual([]);
    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(cluster?.rank).toBe(99);
  });

  test('repairs a stored Target rank from manifest order', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    await database()
      .db.update(targets)
      .set({ rank: 99 })
      .where(eq(targets.name, 'cluster'));

    await loadStoredManifest(database().db, {});

    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(cluster?.rank).toBe(0);
  });

  test('simultaneous processes converge on one declaration', async () => {
    const contender = createDb(database().connect());
    const [first, second] = await Promise.all([
      loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: fixtureText,
      }),
      loadStoredManifest(contender, {
        [MANIFEST_INLINE_VAR]: fixtureText,
      }),
    ]);
    expect(second).toEqual(first);
    expect(first.installation).toBe('example');
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

    await expect(loadStoredManifest(database().db, {})).rejects.toThrow(
      /database installation manifest/,
    );
  });

  test('seeds default placeholder manifest when the database is empty and no bootstrap exists', async () => {
    const loaded = await loadStoredManifest(database().db, {});
    // The placeholder as authored, plus the deployment facts resolved onto it.
    // A deployment that mounts no cloud credential resolves `null`, which is
    // what an installation with no cloud Targets honestly has.
    expect(loaded).toEqual({
      ...DEFAULT_PLACEHOLDER_MANIFEST,
      cloud: { ...DEFAULT_PLACEHOLDER_MANIFEST.cloud, federation: null },
    });
  });

  test('the stored row never holds a fact the deployment declares', async () => {
    // The keys derived away are dropped on the way in, not merely absent from
    // the schema — an installation seeded before the removal has them in its
    // row, and refusing would be a control plane that will not boot.
    await database().client`
      INSERT INTO installation (manifest)
      VALUES (${JSON.stringify({
        ...fixtureManifest,
        cloud: {
          ...fixtureManifest.cloud,
          federation: {
            audience: '//iam.stale.test/pools/stale',
            tokenUrl: 'https://sts.stale.test/v1/token',
            tokenPath: '/var/run/secrets/stale/token',
            impersonationUrl: null,
          },
        },
        charts: { ...fixtureManifest.charts, installer: 'example/spindrift' },
      })}::jsonb)
    `;

    // The deployment's credential wins outright, because it is the only copy
    // left: the row's stale audience reaches no reader.
    const loaded = await loadStoredManifest(
      database().db,
      FIXTURE_DEPLOYMENT_ENV,
    );
    expect(loaded.cloud.federation?.audience).toBe(
      '//iam.example.test/projects/1/locations/global/workloadIdentityPools/example/providers/cluster',
    );
    expect(loaded.charts).not.toHaveProperty('installer');

    const [row] = await database().db.select().from(installation).limit(1);
    expect(row?.manifest.cloud).not.toHaveProperty('federation');
    expect(row?.manifest.charts).not.toHaveProperty('installer');
  });
});
