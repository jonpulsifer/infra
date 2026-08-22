import { describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type {
  AuthoredManifest,
  TargetAdapter,
} from '../../src/config/manifest.schema.ts';
import {
  DEFAULT_PLACEHOLDER_MANIFEST,
  MANIFEST_INLINE_VAR,
  ManifestError,
  UNSERVED_HOSTNAME,
} from '../../src/config/manifest.ts';
import {
  diffManifestPaths,
  governedSliceRefusal,
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

/** The `targets.id` for the surface named by `(vessel, adapter)`. */
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
      // With the optional network, so the round-trip below proves the strict
      // location schema accepts one and the store carries it onto the row.
      location: {
        project: 'example-vessel',
        network: { name: 'example-network', region: 'example-region' },
      },
      // Carried from the fixture rather than restated: the home vessel is the
      // one that must declare these, and which vessel that is comes from the
      // fixture's own `installation.homeVessel`.
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

describe('the stored installation manifest', () => {
  test('stores declared configuration, then boots from the database alone', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(first.installation.name).toBe('example');

    const later = await loadStoredManifest(database().db, {});
    expect(later).toEqual(first);
  });

  test('seeds manifest Targets as disconnected rows in manifest rank order', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });

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
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });

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
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });
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

    // Configuration is the UI's to drive, so the trigger for reconciliation is
    // an operator submitting a document — which is what a settings write is,
    // and it is `writeStoredManifest` on both the seed path and
    // `configureInstallation`. Written through that call rather than by
    // updating the row and rebooting: a boot writes the stored document back
    // without re-asserting it (see the test below), so the raw-update spelling
    // was asserting this behaviour through the one path that no longer has it.
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

    // The restart. It used to be the whole defect: `loadStoredManifest` writes
    // the stored document back on every boot, and reconciliation re-asserted
    // the manifest's copy of the connection over the row — so a connect-screen
    // edit lasted exactly until the next pod rolled, silently.
    await loadStoredManifest(database().db, {});

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

  test('a declaration seeds an empty installation and never governs a seeded one', async () => {
    const first = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    expect(first.installation.name).toBe('example');
    const changed = fixtureText.replace('name: example', 'name: replacement');

    // A rollout must not revert what an operator just configured, so the row
    // wins over the declaration that seeded it.
    const later = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });
    expect(later).toEqual(first);
    expect(later.installation.name).toBe('example');
  });

  test('discarding the row re-seeds from the declaration', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const changed = fixtureText.replace('name: example', 'name: replacement');

    // The deliberate act that makes a declaration apply again. It is also the
    // whole of the tear-down-and-redeploy loop: an installation that lost its
    // database comes back configured without anyone opening a browser.
    await database().db.delete(installation);

    const reseeded = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });
    expect(reseeded.installation.name).toBe('replacement');
    expect(await loadStoredManifest(database().db, {})).toEqual(reseeded);
  });

  test('updating declared configuration preserves connected Target state', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
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
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: changed,
    });

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
        [MANIFEST_INLINE_VAR]: fixtureText.replace('name: example', 'name: ""'),
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
    expect(zoneFor('private', booted.dns.zones)).toBe('apps.example.test');

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

  test('a declared write updates an existing Target’s asserted reaches, and a boot does not', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(connectedManifest),
    });
    const seeded = (
      await database()
        .db.select()
        .from(targets)
        .innerJoin(vessels, eq(targets.vesselId, vessels.id))
        .where(
          and(eq(vessels.name, 'cluster'), eq(targets.adapter, 'kubernetes')),
        )
    )[0]?.targets;
    // Nobody has said, so the row asserts nothing and the adapter's floor is
    // the whole answer — §3's asserted half is stated, never reported.
    expect(seeded?.reaches).toBeNull();

    // The declaration now states one. Before this, `reaches` was written on
    // INSERT only: a Target that already existed could never be given an
    // asserted reach through any supported path, so a document that had always
    // declared `public` never reached the row rendering the deploy.
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

    // And the other half of 52's rule, one noun down: a reach is something an
    // operator can have set on the row through the connect screen, so a boot —
    // which declares nothing, it only writes back the document the installation
    // already had — must leave it exactly where the operator put it.
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
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    await database()
      .db.update(targets)
      .set({ rank: 99 })
      .where(eq(targets.id, await targetIdOf('cluster')));

    await loadStoredManifest(database().db, {});

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

    await expect(loadStoredManifest(database().db, {})).rejects.toThrow(
      /database installation manifest/,
    );
  });

  test('seeds default placeholder manifest when the database is empty and no bootstrap exists', async () => {
    const loaded = await loadStoredManifest(database().db, {});
    // The placeholder as authored, plus the deployment facts resolved onto it.
    // A deployment that mounts no cloud credential resolves `null`, which is
    // what an installation with no cloud Targets honestly has; a deployment
    // that serves no origin resolves the hostname no browser will run a
    // ceremony against, which is what an unreachable installation honestly is.
    expect(loaded).toEqual({
      ...DEFAULT_PLACEHOLDER_MANIFEST,
      cloud: { federation: null },
      boundary: { trustedGateway: false },
      controlPlane: { hostname: UNSERVED_HOSTNAME },
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
    // An ordinary boundary, deliberately: the two the installation is built on
    // are reconciled from the declaration on every boot, so a difference there
    // is one a boot resolves rather than one to warn about.
    const seeded = {
      ...connectedManifest,
      vessels: [
        ...connectedManifest.vessels,
        {
          name: 'elsewhere',
          kind: 'cluster' as const,
          location: { apiServer: 'https://elsewhere.example.test' },
        },
      ],
    } satisfies AuthoredManifest;
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: JSON.stringify(seeded),
    });
    const declared = {
      ...seeded,
      vessels: seeded.vessels.map((vessel) =>
        vessel.name === 'elsewhere'
          ? {
              name: 'elsewhere',
              kind: 'cluster' as const,
              location: {
                apiServer: 'https://declared-elsewhere.example.test',
              },
            }
          : vessel,
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
        message.includes('vessels.2.location.apiServer'),
      ),
    ).toBe(true);
    expect(
      messages.some((message) => message.includes('declared-elsewhere')),
    ).toBe(false);
  });
});

/**
 * The one exception to "a declaration seeds and does not govern".
 *
 * It is a narrowing rather than an inversion: the vessel this control plane runs
 * on and the vessel holding its shared services reconcile from the mounted
 * declaration on every boot, because you should not be able to click your way
 * into an unbootable control plane or a home pointing at nothing. Every other
 * vessel keeps the rule exactly.
 */
describe('the two vessels the installation is built on are governed', () => {
  /** A declaration with a third, ordinary boundary beside the fixture's two. */
  function withAppVessel(apiServer: string, homeProject: string) {
    return JSON.stringify({
      ...connectedManifest,
      vessels: [
        ...connectedManifest.vessels.map((vessel) =>
          vessel.name === 'cloud'
            ? { ...vessel, location: { project: homeProject } }
            : vessel,
        ),
        { name: 'elsewhere', kind: 'cluster', location: { apiServer } },
      ],
      targets: [
        ...connectedManifest.targets,
        { vessel: 'elsewhere', adapter: 'kubernetes' },
      ],
    });
  }

  async function locationOf(name: string) {
    const [row] = await database()
      .db.select({ location: vessels.location })
      .from(vessels)
      .where(eq(vessels.name, name));
    return row?.location;
  }

  test('a boot moves the home vessel and leaves an ordinary one alone', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withAppVessel(
        'https://elsewhere.example.test',
        'first-home',
      ),
    });

    // Both edited in the declaration, and only one of them is the
    // declaration's to move on a boot.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withAppVessel(
        'https://moved.example.test',
        'second-home',
      ),
    });

    expect(await locationOf('cloud')).toEqual({
      kind: 'gcp-project',
      project: 'second-home',
    });
    expect(await locationOf('elsewhere')).toEqual({
      kind: 'cluster',
      apiServer: 'https://elsewhere.example.test',
    });
  });

  test('moving the home vessel reassesses the surfaces on it', async () => {
    // A Target's checklist is a set of claims about a place. Move the place and
    // every one of them is about somewhere else — the same reason a `declared`
    // write resets them.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withAppVessel('https://a.example.test', 'before'),
    });
    const id = await targetIdOf('cloud', 'cloudrun');
    await database()
      .db.update(targets)
      .set({ health: 'healthy', inspectedAt: new Date() })
      .where(eq(targets.id, id));

    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withAppVessel('https://a.example.test', 'after'),
    });

    const [row] = await database()
      .db.select()
      .from(targets)
      .where(eq(targets.id, id));
    expect(row?.health).toBe('unhealthy');
    expect(row?.inspectedAt).toBeNull();
  });

  /** The fixture, with a home vessel a declaration can move. */
  function homeAt(project: string) {
    return JSON.stringify({
      ...fixtureManifest,
      vessels: fixtureManifest.vessels.map((vessel) =>
        vessel.name === fixtureManifest.installation.homeVessel
          ? { ...vessel, location: { project } }
          : vessel,
      ),
    });
  }

  test('a boot that moves the home vessel keeps the connection an operator made', async () => {
    // The fixture seeds its Targets with no connection — §13's half-ready state
    // — so on a boot the manifest's copy of one is `null`. Re-asserting it
    // because the boundary moved would discard what the connect screen wrote
    // while leaving the row reading `connected`, which is a Target every loop
    // and every deploy path silently skips.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: homeAt('before'),
    });
    const id = await targetIdOf('cloud', 'cloudrun');
    const connection = connectionFor('cloudrun');
    await database()
      .db.update(targets)
      .set({
        status: 'connected',
        connection,
        health: 'healthy',
        inspectedAt: new Date(),
      })
      .where(eq(targets.id, id));

    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: homeAt('after'),
    });

    const [row] = await database()
      .db.select()
      .from(targets)
      .where(eq(targets.id, id));
    expect(row?.status).toBe('connected');
    expect(row?.connection).toEqual(connection);
    // Reassessed, though: every claim on the checklist was about the old place.
    expect(row?.health).toBe('unhealthy');
    expect(row?.inspectedAt).toBeNull();
    // And it says which half moved. "Declared Target connection is awaiting
    // inspection" would send an operator to a declaration that says nothing
    // about this Target's connection.
    expect(row?.prerequisites?.[0]?.detail).toContain('boundary');
  });

  test('a boot leaves an address the declaration does not state', async () => {
    // The fixture declares both boundaries and neither location, which is the
    // half-ready state §13 intends to be visible: the address comes from the
    // connect act. Nulling the row on the strength of a declaration that said
    // nothing about it undid that act on every restart.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });
    const located = {
      kind: 'gcp-project' as const,
      project: 'typed-at-connect',
    };
    await database()
      .db.update(vessels)
      .set({ location: located })
      .where(eq(vessels.name, 'cloud'));

    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: fixtureText,
    });

    expect(await locationOf('cloud')).toEqual(located);
  });
});

/**
 * The repository the governed vessels' roots are paths inside.
 *
 * Governed with them and for their sake: a vessel entry carries `terraformRoot`
 * as a path relative to this repository, so governing the path while the row
 * keeps the repository is two halves of one address that can disagree with
 * nothing to notice. The failure it produces is silent — a declaration that
 * names the repository lands on an installation that has never booted and on no
 * other, so the feature it feeds reads as broken on exactly the installations
 * that have been running longest.
 */
describe('the repository the boundaries are declared in', () => {
  /** The fixture, naming a different infrastructure repository. */
  function declaredAt(repository: string): string {
    return JSON.stringify({
      ...fixtureManifest,
      github: {
        ...fixtureManifest.github,
        infrastructureRepository: repository,
      },
    });
  }

  test('a declaration reaches an installation that is already seeded', async () => {
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: declaredAt('example/first'),
    });

    const manifest = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: declaredAt('example/second'),
    });

    expect(manifest.github.infrastructureRepository).toBe('example/second');
  });

  test('a declaration that names none leaves what an operator set', async () => {
    // The chart's own placeholder omits the key, so reading its absence as an
    // assertion would clear this on every boot of every default installation.
    const withoutKey = JSON.stringify({
      ...fixtureManifest,
      github: {
        ...fixtureManifest.github,
        infrastructureRepository: undefined,
      },
    });
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withoutKey,
    });
    const [row] = await database().db.select().from(installation);
    await writeStoredManifest(database().db, {
      ...(row!.manifest as AuthoredManifest),
      github: {
        ...(row!.manifest as AuthoredManifest).github,
        infrastructureRepository: 'operator/chosen',
      },
    });

    const manifest = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: withoutKey,
    });
    expect(manifest.github.infrastructureRepository).toBe('operator/chosen');
  });

  test('the rest of the block stays the row’s', async () => {
    // The host's endpoints and the pinned workflow are configured through
    // the settings screen; only the repository the roots live in is governed.
    await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: declaredAt('example/first'),
    });
    const [row] = await database().db.select().from(installation);
    await writeStoredManifest(database().db, {
      ...(row!.manifest as AuthoredManifest),
      github: {
        ...(row!.manifest as AuthoredManifest).github,
        webBaseUrl: 'https://git.configured.example',
      },
    });

    const manifest = await loadStoredManifest(database().db, {
      [MANIFEST_INLINE_VAR]: declaredAt('example/first'),
    });
    expect(manifest.github.webBaseUrl).toBe('https://git.configured.example');
  });
});

/**
 * The other half of governing those two: a write into the governed slice is
 * refused rather than accepted and reverted at the next boot.
 */
describe('a write the next boot would take back is refused', () => {
  /** The home vessel's shared services, edited the way the product edits them. */
  function withSourceBucket(bucket: string): AuthoredManifest {
    return {
      ...connectedManifest,
      vessels: connectedManifest.vessels.map((vessel) =>
        vessel.name === connectedManifest.installation.homeVessel &&
        vessel.shared !== undefined
          ? { ...vessel, shared: { ...vessel.shared, sourceBucket: bucket } }
          : vessel,
      ),
    } as AuthoredManifest;
  }

  test('the paths a boot would revert are named', () => {
    const refusal = governedSliceRefusal(
      withSourceBucket('operator-chosen'),
      connectedManifest,
    );
    expect(refusal).toContain('vessels.1.shared.sourceBucket');
    expect(refusal).toContain('Change the declaration');
    // Paths, never values, for the reason `diffManifestPaths` gives.
    expect(refusal).not.toContain('operator-chosen');
  });

  test('the infrastructure repository is refused where a declaration names one', () => {
    const refusal = governedSliceRefusal(
      {
        ...connectedManifest,
        github: {
          ...connectedManifest.github,
          infrastructureRepository: 'operator/chosen',
        },
      } as AuthoredManifest,
      connectedManifest,
    );
    expect(refusal).toContain('github.infrastructureRepository');
    expect(refusal).not.toContain('operator/chosen');
  });

  test('a re-pointed pointer is named too', () => {
    const refusal = governedSliceRefusal(
      {
        ...connectedManifest,
        installation: {
          ...connectedManifest.installation,
          controlPlaneVessel: 'cloud',
        },
      },
      connectedManifest,
    );
    expect(refusal).toContain('installation.controlPlaneVessel');
  });

  test('everything outside the governed slice is still this screen’s to drive', () => {
    expect(
      governedSliceRefusal(
        {
          ...connectedManifest,
          sources: {
            ...connectedManifest.sources,
            buckets: [...connectedManifest.sources.buckets, 'another-bucket'],
          },
        },
        connectedManifest,
      ),
    ).toBeNull();
  });

  test('with no declaration mounted there is nothing to govern', () => {
    // An installation running with no declaration owns its own document
    // outright, which is the state the shared services are configured in.
    expect(
      governedSliceRefusal(withSourceBucket('operator-chosen'), null),
    ).toBeNull();
  });
});
