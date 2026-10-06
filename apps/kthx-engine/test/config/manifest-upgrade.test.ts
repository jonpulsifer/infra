/**
 * Every stored manifest shape in `test/fixtures/stored-manifests/` must boot.
 * A snapshot is never edited, and the newest one must need no upgrade.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AuthoredManifest,
  InstallationManifest,
} from '../../src/config/manifest.schema.ts';
import { validateManifest } from '../../src/config/manifest.ts';
import { loadStoredManifest } from '../../src/config/manifest-store.ts';
import { upgradeManifestDocument } from '../../src/config/manifest-upgrade.ts';
import { installation } from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const CORPUS = join(import.meta.dir, '../fixtures/stored-manifests');
const SNAPSHOTS = readdirSync(CORPUS)
  .filter((name) => name.endsWith('.yaml'))
  .sort();

/** Parsed per call, so one test's mutation never reaches the next. */
function snapshot(name: string): Record<string, unknown> {
  return Bun.YAML.parse(readFileSync(join(CORPUS, name), 'utf8')) as Record<
    string,
    unknown
  >;
}

const database = withIsolatedDatabase();

describe('every stored manifest this project has ever written', () => {
  test.each(SNAPSHOTS)('%s boots without re-seeding', async (name) => {
    const document = snapshot(name);
    await database()
      .db.insert(installation)
      .values({ manifest: document as unknown as AuthoredManifest });

    const original = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(String(args[0]));
    };
    let loaded: InstallationManifest;
    try {
      loaded = await loadStoredManifest(database().db);
    } finally {
      console.warn = original;
    }

    // Older snapshots store `installation` as a bare name string.
    expect(loaded.installation.name).toBe(
      typeof document.installation === 'string'
        ? document.installation
        : (document.installation as { name: string }).name,
    );
    expect(warnings.filter((message) => message.includes('re-seeded'))).toEqual(
      [],
    );

    // The row is rewritten as a current document, so the upgrade runs once.
    const [row] = await database()
      .db.select({ manifest: installation.manifest })
      .from(installation);
    expect(() => validateManifest(row?.manifest, name)).not.toThrow();
    expect(upgradeManifestDocument(row?.manifest)).toEqual(
      row?.manifest as unknown,
    );
  });

  test('the newest snapshot is the shape this build writes, needing no upgrade', () => {
    const newest = SNAPSHOTS.at(-1);
    if (newest === undefined) throw new Error('the corpus is empty');
    const document = snapshot(newest);

    // On failure, copy the newest snapshot to the next number, edit the copy,
    // and add the step to `manifest-upgrade.ts`. Never edit a snapshot in
    // place.
    expect(upgradeManifestDocument(document)).toEqual(document);
    expect(() => validateManifest(document, newest)).not.toThrow();
  });

  test('the oldest snapshot is genuinely refused without the upgrade', () => {
    // Otherwise the corpus would prove no upgrade step is needed.
    const oldest = SNAPSHOTS.at(0);
    if (oldest === undefined) throw new Error('the corpus is empty');
    expect(upgradeManifestDocument(snapshot(oldest))).not.toEqual(
      snapshot(oldest),
    );
  });
});

describe('the vessels a pre-declaration document is upgraded into', () => {
  const document = snapshot('01-suffix-paired-vessels.yaml');

  test('are the ones the seeding path used to derive on every boot', () => {
    // The names and locations of the existing vessel rows, so no second set
    // appears.
    const upgraded = upgradeManifestDocument(document) as {
      vessels: unknown[];
    };
    expect(upgraded.vessels).toEqual([
      {
        name: 'cluster',
        kind: 'cluster',
        location: { apiServer: 'https://cluster.example.test' },
        servedHosts: ['apps.example.test'],
        reachableRegistries: ['registry.example.test'],
      },
      {
        name: 'cloud',
        kind: 'gcp-project',
        location: { project: 'example-vessel' },
        // The union of the hosts both surfaces stated.
        servedHosts: ['hosting.example.test', 'run.example.test'],
        reachableRegistries: ['mirror.example.test'],
        // The snapshot's `cloud.homeVesselProject` names no declared vessel, so
        // the first cloud vessel takes the home role.
        shared: {
          sourceBucket: 'example-source-bucket',
          artifactsProject: 'example-artifacts',
          secretStoreContainer: 'example-secrets',
        },
      },
    ]);
  });

  test('leave the Targets in order, carrying only their own surface', () => {
    // Rank is array order. The chained upgrade also drops each entry's `name`.
    const upgraded = upgradeManifestDocument(document) as {
      targets: { vessel: string; adapter: string; connection?: object }[];
    };
    expect(
      upgraded.targets.map((target) => [target.vessel, target.adapter]),
    ).toEqual([
      ['cluster', 'kubernetes'],
      ['cloud', 'cloudrun'],
      ['cloud', 'static'],
    ]);
    for (const target of upgraded.targets) {
      expect(target).not.toHaveProperty('name');
      expect(Object.keys(target.connection ?? {})).not.toContain('apiServer');
      expect(Object.keys(target.connection ?? {})).not.toContain('project');
      expect(Object.keys(target.connection ?? {})).not.toContain('servedHosts');
      expect(Object.keys(target.connection ?? {})).not.toContain(
        'reachableRegistries',
      );
    }
  });

  test('take their kind from the address stated, not from the adapter', () => {
    // A `kubernetes` surface can sit in a project, so the kind comes from the
    // address.
    const upgraded = upgradeManifestDocument({
      targets: [
        {
          name: 'inside-a-project',
          adapter: 'kubernetes',
          connection: { project: 'example-vessel', namespace: 'apps' },
        },
      ],
    }) as { vessels: unknown[] };
    expect(upgraded.vessels).toEqual([
      {
        name: 'inside-a-project',
        kind: 'gcp-project',
        location: { project: 'example-vessel' },
      },
    ]);
  });

  test('and a boundary no address was stated for keeps the row it has', () => {
    // With no address to read, the kind matches the row `0022_vessels.sql`
    // created, and the location is omitted.
    const upgraded = upgradeManifestDocument({
      targets: [{ name: 'nowhere', adapter: 'kubernetes' }],
    }) as { vessels: unknown[] };
    expect(upgraded.vessels).toEqual([{ name: 'nowhere', kind: 'cluster' }]);
  });

  test('and one address-less seed does not take the whole document down', () => {
    // `vessels` is required, so an upgrade that dropped it would fail
    // validation.
    const seeded = snapshot('01-suffix-paired-vessels.yaml') as {
      targets: Record<string, unknown>[];
    };
    delete seeded.targets[0]?.connection;

    const upgraded = upgradeManifestDocument(seeded) as {
      vessels: { name: string; location?: unknown }[];
    };
    expect(upgraded.vessels.map((vessel) => vessel.name)).toEqual([
      'cluster',
      'cloud',
    ]);
    expect(upgraded.vessels[0]).not.toHaveProperty('location');
    expect(() => validateManifest(upgraded, 'test')).not.toThrow();
  });

  test('and a cluster keeps its whole name, suffix and all', () => {
    // Only project surfaces carry a suffix. `reconcileManifestVessels` matches
    // by name, so stripping one here would create a second vessel.
    const upgraded = upgradeManifestDocument({
      targets: [
        {
          name: 'folly-kubernetes',
          adapter: 'kubernetes',
          connection: {
            apiServer: 'https://folly.example.test',
            namespace: 'apps',
          },
        },
      ],
    }) as { vessels: { name: string }[]; targets: { vessel: string }[] };
    expect(upgraded.vessels.map((vessel) => vessel.name)).toEqual([
      'folly-kubernetes',
    ]);
    expect(upgraded.targets.map((target) => target.vessel)).toEqual([
      'folly-kubernetes',
    ]);
  });

  test('is a no-op on a document that already declares them', () => {
    // `11` needs no upgrade.
    const current = snapshot('11-deployment-serves-the-control-plane.yaml');
    expect(upgradeManifestDocument(current)).toEqual(current);
  });
});

/**
 * `cloud.homeVesselProject`, `cloud.artifactsProject`, `sources.defaultBucket`
 * and `secretStore.container` move onto the home vessel.
 */
describe('the two vessels an installation is built on, recovered once', () => {
  test('the home vessel is the boundary the old project id named', () => {
    // `03` names `example-home`, which no vessel declares, so the first cloud
    // vessel takes the role.
    const upgraded = upgradeManifestDocument(
      snapshot('03-target-is-vessel-and-surface.yaml'),
    ) as {
      installation: {
        name: string;
        controlPlaneVessel: string;
        homeVessel: string;
      };
      vessels: { name: string; shared?: unknown }[];
      sources: Record<string, unknown>;
      secretStore: Record<string, unknown>;
      cloud?: unknown;
    };

    expect(upgraded.installation).toEqual({
      name: 'stored-without-target-names',
      // The rank-0 Target's vessel.
      controlPlaneVessel: 'cluster',
      homeVessel: 'cloud',
    });
    expect(
      upgraded.vessels.find((vessel) => vessel.name === 'cloud')?.shared,
    ).toEqual({
      sourceBucket: 'example-source-bucket',
      artifactsProject: 'example-artifacts',
      secretStoreContainer: 'example-secrets',
    });
    // The schema lets only one vessel carry them.
    expect(
      upgraded.vessels.filter((vessel) => vessel.shared !== undefined),
    ).toHaveLength(1);

    // The source keys are removed, so no value lives in two places.
    expect(upgraded.cloud).toBeUndefined();
    expect(upgraded.sources).not.toHaveProperty('defaultBucket');
    expect(upgraded.secretStore).not.toHaveProperty('container');
  });

  test('a document whose home project is a declared boundary keeps that one', () => {
    // `cloud.homeVesselProject` matches a declared vessel's `location.project`.
    const document = snapshot('03-target-is-vessel-and-surface.yaml') as Record<
      string,
      unknown
    >;
    const cloud = document.cloud as Record<string, unknown>;
    const upgraded = upgradeManifestDocument({
      ...document,
      cloud: { ...cloud, homeVesselProject: 'example-vessel' },
    }) as { installation: { homeVessel: string } };
    expect(upgraded.installation.homeVessel).toBe('cloud');
  });

  test('a document with no staging default takes the first declared bucket', () => {
    // `sources.defaultBucket` is optional in old documents, and
    // `sources.buckets` always has at least one entry.
    const document = snapshot('03-target-is-vessel-and-surface.yaml') as Record<
      string,
      unknown
    >;
    const sources = document.sources as Record<string, unknown>;
    const { defaultBucket: _dropped, ...withoutDefault } = sources;
    const upgraded = upgradeManifestDocument({
      ...document,
      sources: withoutDefault,
    }) as { vessels: { name: string; shared?: { sourceBucket: string } }[] };
    expect(
      upgraded.vessels.find((vessel) => vessel.name === 'cloud')?.shared
        ?.sourceBucket,
    ).toBe('example-source-bucket');
  });
});

describe('the zones a reach-keyed document is upgraded into', () => {
  const zonesOf = (document: unknown): unknown =>
    (upgradeManifestDocument(document) as { dns: { zones: unknown } }).dns
      .zones;

  test('one zone at both reaches becomes one entry serving both', () => {
    // One entry keeps a reach flip a record re-point with a stable hostname.
    expect(
      zonesOf({
        dns: {
          zones: { private: 'one.example.test', public: 'one.example.test' },
        },
      }),
    ).toEqual([{ name: 'one.example.test', reaches: ['private', 'public'] }]);
  });

  test('two zones become two entries of one reach each', () => {
    // Split horizon, where changing reach is a rename.
    expect(
      zonesOf({
        dns: {
          zones: { private: 'lan.example.test', public: 'www.example.test' },
        },
      }),
    ).toEqual([
      { name: 'lan.example.test', reaches: ['private'] },
      { name: 'www.example.test', reaches: ['public'] },
    ]);
  });

  test('a document already holding the list is left exactly as it arrived', () => {
    // A third zone an operator added in the UI must survive the upgrade.
    const current = {
      dns: {
        zones: [
          { name: 'one.example.test', reaches: ['private', 'public'] },
          { name: 'shop.example.test', reaches: ['public'] },
        ],
      },
    };
    expect(upgradeManifestDocument(current)).toEqual(current);
  });
});
