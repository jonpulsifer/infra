import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AuthoredManifest } from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  MANIFEST_INLINE_VAR,
  ManifestError,
} from '../../src/config/manifest.ts';
import {
  diffManifestPaths,
  loadStoredManifest,
  targetConnectionDivergence,
  writeStoredManifest,
} from '../../src/config/manifest-store.ts';
import { createDb } from '../../src/db/client.ts';
import { installation, targets } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  connectionFor,
  FIXTURE_DEPLOYMENT_ENV,
} from '../harness/installation.ts';

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
          region: 'example-region',
          endpoint: 'https://run.example.test',
        },
      },
      {
        name: 'cloud-static',
        status: 'connected',
        connection: {
          adapter: 'static',
          endpoint: 'https://hosting.example.test',
        },
      },
    ]);

    // The boundary facts the seeds stated per surface are stored once. Both
    // cloud surfaces are one vessel, named for what the suffix used to encode.
    const vesselRows = await database().db.query.vessels.findMany({
      orderBy: (vessels, { asc }) => [asc(vessels.name)],
    });
    expect(
      vesselRows
        // The harness seeds one vessel per kind for fixtures that insert a
        // Target directly; what this test is about is the ones the manifest
        // described.
        .filter((vessel) => !vessel.name.startsWith('fixture-'))
        .map(({ name, kind, location }) => ({ name, kind, location })),
    ).toEqual([
      {
        name: 'cloud',
        kind: 'gcp-project',
        location: { kind: 'gcp-project', project: 'example-vessel' },
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
    // an operator submitting a document — which is what a settings write is,
    // and it is `writeStoredManifest` on both the seed path and
    // `configureInstallation`. Written through that call rather than by
    // updating the row and rebooting: a boot writes the stored document back
    // without re-asserting it (see the test below), so the raw-update spelling
    // was asserting this behaviour through the one path that no longer has it.
    await writeStoredManifest(database().db, changed);

    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    // The address moved to the boundary, so that is where the edit lands —
    // and the surface it carries is still reassessed, because what changed is
    // still where this Target is.
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
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });

    // What `connectTarget` writes: the row, and only the row. The manifest is
    // untouched, which is the state 52 is about — the operator corrected a
    // Target through the product and the document still declares the old one.
    const corrected = {
      adapter: 'kubernetes' as const,
      // No `apiServer`: where the cluster is belongs to its vessel now, and
      // this is the surface's half.
      namespace: 'apps',
      delivery: {
        flavour: 'flux-helmrelease' as const,
        namespace: 'apps',
        sourceRef: { name: 'infra', namespace: 'flux-system' },
      },
      chartContract: '2',
      chartValues: {
        platform: {
          gateway: { name: 'spindrift-apps', namespace: 'spindrift-apps' },
        },
      },
    };
    await database()
      .db.update(targets)
      .set({ connection: corrected, health: 'healthy' })
      .where(eq(targets.name, 'cluster'));

    // The restart. It used to be the whole defect: `loadStoredManifest` writes
    // the stored document back on every boot, and reconciliation re-asserted
    // the manifest's copy of the connection over the row — so a connect-screen
    // edit lasted exactly until the next pod rolled, silently.
    await loadStoredManifest(database().db, {});

    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(cluster?.connection).toEqual(corrected);
    // Nothing was re-declared, so nothing about the Target's assessment was
    // invalidated either — a boot that reset this to unhealthy would make every
    // rollout re-inspect every Target it had not been asked to change.
    expect(cluster?.health).toBe('healthy');

    // And the divergence is readable rather than silent: the row won, so what
    // the manifest still declares has to be somewhere an operator can see it
    // before they submit that document in Settings and take their own edit back.
    expect(
      targetConnectionDivergence(
        connectedManifest.targets[0],
        cluster?.connection ?? null,
      ),
    ).toEqual(['connection.chartValues']);
  });

  test('a Target the manifest declares no connection for never diverges', async () => {
    // §13 lets a seed carry an identity and leave the connection to the
    // product. That Target's connection is the row's outright, so there is
    // nothing for it to disagree with — reporting one would put a permanent
    // warning on every Target connected through the screen it belongs to.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    await database()
      .db.update(targets)
      .set({ connection: connectionFor('kubernetes'), status: 'connected' })
      .where(eq(targets.name, 'cluster'));

    const cluster = await database().db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.name, 'cluster'),
    });
    expect(
      targetConnectionDivergence(
        fixtureManifest.targets.find((target) => target.name === 'cluster'),
        cluster?.connection ?? null,
      ),
    ).toEqual([]);
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

    // Ignored rather than fatal: a declaration does not govern a seeded
    // installation, so this document was never going to be read. The row is
    // what boots, unchanged.
    expect(
      await loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: malformed,
      }),
    ).toEqual(first);

    expect(await loadStoredManifest(database().db, {})).toEqual(first);
  });

  test('a declaration this build cannot parse does not stop a seeded boot', async () => {
    // The ordinary shape of a rollout: a manifest key lands in the declaration
    // with the merge and in the image with the digest bump, and between them
    // every replica reads a document carrying a field it has no schema for.
    // Crashing there takes a healthy control plane down over a value it had
    // already decided not to use — the same controller/declaration skew the
    // build workflow's `tags` default exists to absorb.
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const fromTheFuture = fixtureText.replace(
      'installation: example',
      'installation: example\nsomethingThisBuildHasNeverHeardOf: true',
    );

    expect(
      await loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: fromTheFuture,
      }),
    ).toEqual(first);
  });

  test('an unseeded installation still refuses to boot on a bad declaration', async () => {
    // The other half, and it has to stay fatal: with no row the declaration is
    // the whole configuration, and continuing would boot the placeholder as
    // though the operator had declared nothing at all.
    await expect(
      loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: fixtureText.replace(
          'installation: example',
          'installation: ""',
        ),
      }),
    ).rejects.toThrow(ManifestError);
  });

  test('a stored row this build cannot parse re-seeds from the declaration', async () => {
    // What actually happened: `dns.zones` replaced `dns.apexZone`, the row
    // written by the previous image kept the old shape, and every replica
    // crash-looped on a document whose mounted declaration was already correct.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    await database()
      .db.update(installation)
      .set({
        manifest: {
          ...fixtureManifest,
          dns: { apexZone: 'apps.example.test', vanityZone: 'example.test' },
        } as unknown as AuthoredManifest,
      });

    const booted = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(booted.dns.zones.private).toBe('apps.example.test');

    // Nothing honest to boot as without one, so the error stands.
    await database()
      .db.update(installation)
      .set({
        manifest: { installation: 'broken' } as unknown as AuthoredManifest,
      });
    await expect(loadStoredManifest(database().db, {})).rejects.toThrow(
      ManifestError,
    );
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

  test('a row restating a fact the deployment declares is refused', async () => {
    // The schema is strict, so the two keys the deployment owns cannot reach a
    // reader from storage either. The installer chart refuses them at render,
    // which is where an operator meets this.
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

describe('naming where a declaration disagrees with the stored row', () => {
  test('an identical declaration reports no divergence', () => {
    expect(diffManifestPaths(connectedManifest, connectedManifest)).toEqual([]);
  });

  test('names the dotted paths that differ, and only those', () => {
    // Mirrors the live bug this guards against: PR #1607 moved the offsite
    // Target's gateway — a value nested inside one Target's connection — in
    // the declaration, while the row it seeded and every other field of
    // every other Target stayed exactly where they were.
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

    const paths = diffManifestPaths(connectedManifest, stored);
    expect(paths).toEqual(['targets.0.connection.apiServer']);
    // Neither the declared value nor the stored value appears anywhere in
    // what was returned — a path names *where* the two documents disagree,
    // never *what* they disagree about. That is what keeps a value the
    // schema has not been written yet — a credential on some future Target
    // connection — off a startup log line, without this function needing to
    // know which paths are sensitive.
    const rendered = JSON.stringify(paths);
    expect(rendered).not.toContain('cluster.example.test');
    expect(rendered).not.toContain('replacement.example.test');
  });

  test('the startup warning names the differing path, and still no value', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });
    const declared = {
      ...connectedManifest,
      targets: connectedManifest.targets.map((target) =>
        target.adapter === 'kubernetes'
          ? {
              ...target,
              connection: {
                ...target.connection,
                apiServer: 'https://declared-elsewhere.example.test',
              },
            }
          : target,
      ),
    } satisfies AuthoredManifest;

    // `bun:test`'s `spyOn` does not intercept `console.warn` — verified against
    // a two-line reproduction outside this suite — so this captures it the
    // plain way: swap the method out, put it back in `finally`.
    const original = console.warn;
    const calls: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      calls.push(args);
    };
    try {
      // A declaration seeds and does not govern (see above), so this write is
      // ignored — the point here is only what the warning it produces says.
      await loadStoredManifest(database().db, {
        [MANIFEST_INLINE_VAR]: JSON.stringify(declared),
      });
    } finally {
      console.warn = original;
    }

    const messages = calls.map((call) => String(call[0]));
    expect(
      messages.some((message) =>
        message.includes('targets.0.connection.apiServer'),
      ),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes('declared-elsewhere')),
    ).toBe(false);
  });
});
