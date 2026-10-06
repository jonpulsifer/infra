/**
 * The standing checklist a boundary is assessed against. The cloud APIs are
 * faked at HTTP, so the real discovery client and its key-purpose filter run.
 */
import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import type { SecretStore } from '../../src/adapters/store/contract.ts';
import type { AdapterRegistry } from '../../src/commands/types.ts';
import type { InstallationManifest } from '../../src/config/manifest.schema.ts';
import { vessels } from '../../src/db/schema.ts';
import type { VesselPrerequisiteResult } from '../../src/domain/vessel.ts';
import { deriveVesselHealth } from '../../src/domain/vessel.ts';
import {
  inspectVessel,
  refreshAllVessels,
} from '../../src/reconciler/vessel-loop.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import {
  FakeGcpDiscovery,
  type FakeGcpDiscoveryOptions,
} from '../harness/fakes/gcp-discovery-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const NOW = new Date('2026-08-07T00:00:00.000Z');
const TOKEN = 'federated-token';

const fixture = await fixtureManifest();

const HOME_PROJECT = 'example-vessel';
const SIGNER_LOCATION = 'example-region';

/**
 * The fixture with the home vessel located in `project`. The fixture states no
 * location, so `null` leaves it unstated.
 */
function installationWith(project: string | null): InstallationManifest {
  return {
    ...fixture,
    vessels: fixture.vessels.map((vessel) =>
      vessel.name === fixture.installation.homeVessel
        ? {
            ...vessel,
            ...(project === null
              ? {}
              : { location: { project } as { project: string } }),
          }
        : vessel,
    ),
  } as InstallationManifest;
}

function store(reachable: boolean): SecretStore {
  return {
    adapter: fixture.secretStore.adapter,
    pinning: 'NATIVE',
    put: () => Promise.reject(new Error('not used')),
    describe: () => Promise.resolve(null),
    versions: () =>
      reachable
        ? Promise.resolve([])
        : Promise.reject(new Error('the secret store refused: 403')),
    destroy: () => Promise.resolve(),
  };
}

interface Wiring {
  readonly manifest?: InstallationManifest;
  readonly storeReachable?: boolean;
  readonly discovery?: FakeGcpDiscoveryOptions | null;
  /** Zones the Cloudflare account answers with; `null` wires no reader. */
  readonly zones?: readonly string[] | null;
}

function context(wiring: Wiring = {}) {
  const manifest = wiring.manifest ?? installationWith(HOME_PROJECT);
  const real = createAdapterRegistry({
    manifest,
    env: {},
    cloudToken: () => TOKEN,
    fetch: new FakeGcpDiscovery({
      token: TOKEN,
      projects: [HOME_PROJECT, 'example-artifacts'],
      buckets: { [HOME_PROJECT]: ['example-source-bucket'] },
      keys: [
        {
          project: 'example-artifacts',
          location: SIGNER_LOCATION,
          ring: 'keys',
          name: 'signer',
        },
      ],
      ...(wiring.discovery ?? {}),
    }).fetch,
  });
  const zones = wiring.zones;
  const adapters: Pick<AdapterRegistry, 'discovery' | 'store' | 'cloudflare'> =
    {
      discovery: () => (wiring.discovery === null ? null : real.discovery!()),
      store: () => store(wiring.storeReachable ?? true),
      cloudflare: () =>
        zones == null
          ? null
          : {
              read: async () => ({
                kind: 'cloudflare-account' as const,
                zones: zones.map((name) => ({
                  name,
                  id: `id-${name}`,
                  status: 'active',
                })),
                workersSubdomain: 'acme',
                pagesProjects: [],
              }),
            },
    };
  return { db: database().db, clock: { now: () => NOW }, adapters, manifest };
}

async function homeChecklist(
  wiring: Wiring = {},
): Promise<Map<string, VesselPrerequisiteResult>> {
  const ctx = context(wiring);
  const home = ctx.manifest.vessels.find(
    (vessel) => vessel.name === ctx.manifest.installation.homeVessel,
  )!;
  const answered = await inspectVessel(
    ctx,
    {
      name: home.name,
      kind: home.kind,
      location:
        home.location === undefined
          ? null
          : ({ kind: home.kind, ...home.location } as never),
    },
    ['home'],
  );
  return new Map(answered.prerequisites.map((item) => [item.name, item]));
}

describe('the four the home vessel carries', () => {
  test('a boundary that holds all four reports every row met', async () => {
    const checklist = await homeChecklist();
    expect([...checklist.keys()]).toEqual([
      'SOURCE_BUCKET',
      'SECRET_STORE',
      'SIGNER_KEY',
      'ARTIFACTS_PROJECT',
    ]);
    expect([...checklist.values()].every((item) => item.met)).toBe(true);
  });

  test('a bucket that is not in the project is the row it should be', async () => {
    // A mistyped bucket shows here, before a build fails on a signed URL.
    const checklist = await homeChecklist({
      discovery: { buckets: { [HOME_PROJECT]: ['some-other-bucket'] } },
    });
    const bucket = checklist.get('SOURCE_BUCKET')!;
    expect(bucket.met).toBe(false);
    expect(bucket.detail).toContain('example-source-bucket');
    // Only that row: the reads are independent.
    expect(checklist.get('SIGNER_KEY')?.met).toBe(true);
    expect(checklist.get('ARTIFACTS_PROJECT')?.met).toBe(true);
  });

  test('a refused read is a different sentence from an absence', async () => {
    // A `403` establishes nothing, so it must not read as an absent bucket.
    const checklist = await homeChecklist({
      discovery: { refuse: { storage: { status: 403, message: 'no' } } },
    });
    const bucket = checklist.get('SOURCE_BUCKET')!;
    expect(bucket.met).toBe(false);
    expect(bucket.detail).toContain('may not list');
    expect(bucket.detail).not.toContain('is not a bucket');
  });

  test('a key of the wrong purpose is not a signer', async () => {
    // A symmetric key would pass every other check and fail at the first
    // cosign call.
    const checklist = await homeChecklist({
      discovery: {
        keys: [
          {
            project: 'example-artifacts',
            location: SIGNER_LOCATION,
            ring: 'keys',
            name: 'signer',
            purpose: 'ENCRYPT_DECRYPT',
          },
        ],
      },
    });
    expect(checklist.get('SIGNER_KEY')?.met).toBe(false);
  });

  test('a store that refuses carries what it said', async () => {
    const checklist = await homeChecklist({ storeReachable: false });
    const item = checklist.get('SECRET_STORE')!;
    expect(item.met).toBe(false);
    expect(item.detail).toContain('403');
  });

  test('a home vessel with no project is not looked for anyway', async () => {
    // A probe would otherwise request `projects/undefined`.
    const checklist = await homeChecklist({
      manifest: installationWith(null),
    });
    expect([...checklist.values()].every((item) => !item.met)).toBe(true);
    expect(checklist.get('SOURCE_BUCKET')?.detail).toContain(
      'states no project',
    );
  });

  test('a process with no cloud client says so on every row', async () => {
    const checklist = await homeChecklist({ discovery: null });
    expect([...checklist.values()].every((item) => !item.met)).toBe(true);
    expect(checklist.get('ARTIFACTS_PROJECT')?.detail).toContain(
      'cannot reach a cloud API',
    );
  });
});

describe('one pass over the boundaries', () => {
  test('writes the checklist and leaves an app vessel asked nothing', async () => {
    const manifest = installationWith(HOME_PROJECT);
    await database()
      .db.insert(vessels)
      .values([
        {
          name: manifest.installation.homeVessel,
          kind: 'gcp-project',
          location: { kind: 'gcp-project', project: HOME_PROJECT },
        },
        {
          name: 'elsewhere',
          kind: 'gcp-project',
          location: { kind: 'gcp-project', project: 'somewhere-else' },
        },
      ]);

    // Every vessel gets a pass, including an app vessel that is asked nothing.
    const refreshed = await refreshAllVessels(context({ manifest }));
    expect(refreshed.map((pass) => pass.vessel)).toContain('cloud');
    expect(refreshed.map((pass) => pass.vessel)).toContain('elsewhere');

    const rows = await database().db.select().from(vessels);
    const home = rows.find((row) => row.name === 'cloud')!;
    const app = rows.find((row) => row.name === 'elsewhere')!;

    expect(home.prerequisites).toHaveLength(4);
    expect(deriveVesselHealth(home.prerequisites!, home.kind, ['home'])).toBe(
      'healthy',
    );
    // An empty checklist with `inspectedAt` set means assessed and asked
    // nothing, a different state from never assessed.
    expect(app.prerequisites).toEqual([]);
    expect(app.inspectedAt).toEqual(NOW);
  });

  test('a pass reports the health it changed', async () => {
    const manifest = installationWith(HOME_PROJECT);
    await database()
      .db.insert(vessels)
      .values({
        name: manifest.installation.homeVessel,
        kind: 'gcp-project',
        location: { kind: 'gcp-project', project: HOME_PROJECT },
      });

    const home = (passes: Awaited<ReturnType<typeof refreshAllVessels>>) =>
      passes.find((pass) => pass.vessel === manifest.installation.homeVessel)!;

    // The first pass has no earlier verdict to change from.
    expect(
      home(await refreshAllVessels(context({ manifest }))),
    ).not.toHaveProperty('healthChangedFrom');

    expect(
      home(
        await refreshAllVessels(context({ manifest, storeReachable: false })),
      ),
    ).toMatchObject({ health: 'unhealthy', healthChangedFrom: 'healthy' });
  });

  test('a row an operator cleared elsewhere goes green on the next pass', async () => {
    // A remediation is applied outside this process, and the next pass sees it
    // with no recheck act.
    const manifest = installationWith(HOME_PROJECT);
    await database()
      .db.insert(vessels)
      .values({
        name: manifest.installation.homeVessel,
        kind: 'gcp-project',
        location: { kind: 'gcp-project', project: HOME_PROJECT },
      });

    const missing = { buckets: { [HOME_PROJECT]: ['some-other-bucket'] } };
    await refreshAllVessels(context({ manifest, discovery: missing }));

    const stored = async () =>
      (await database().db.select().from(vessels)).find(
        (row) => row.name === manifest.installation.homeVessel,
      )!;

    const before = await stored();
    expect(
      before.prerequisites?.find((item) => item.name === 'SOURCE_BUCKET')?.met,
    ).toBe(false);
    expect(
      deriveVesselHealth(before.prerequisites!, before.kind, ['home']),
    ).toBe('unhealthy');

    // The bucket now exists in the project.
    const after = (await refreshAllVessels(context({ manifest }))).find(
      (pass) => pass.vessel === manifest.installation.homeVessel,
    )!;
    expect(after).toMatchObject({
      health: 'healthy',
      healthChangedFrom: 'unhealthy',
    });

    const row = await stored();
    expect(
      row.prerequisites?.find((item) => item.name === 'SOURCE_BUCKET')?.met,
    ).toBe(true);
    // Remediation is composed on read, so the stored row carries none.
    for (const item of row.prerequisites ?? []) {
      expect(item.remediation).toBeUndefined();
    }
  });
});

describe('what a boundary carries, beside whether it can be used', () => {
  test('a Cloudflare account’s inventory is written to its own row', async () => {
    await refreshAllVessels(context({ zones: ['example.test'] }));

    const rows = await database().db.select().from(vessels);
    const account = rows.find((row) => row.kind === 'cloudflare-account')!;

    expect(account.discovery).toEqual({
      kind: 'cloudflare-account',
      zones: [
        { name: 'example.test', id: 'id-example.test', status: 'active' },
      ],
      workersSubdomain: 'acme',
      pagesProjects: [],
    });
    // An account is asked nothing, so its checklist is empty.
    expect(account.prerequisites).toEqual([]);
  });

  test('a kind with no account-wide listing stores none, rather than an empty one', async () => {
    await refreshAllVessels(context({ zones: ['example.test'] }));

    const rows = await database().db.select().from(vessels);
    // `null` means this kind has nothing to read, unlike an account whose
    // reads were refused.
    expect(rows.find((row) => row.kind === 'cluster')!.discovery).toBeNull();
  });

  test('no reader at all is a sentence, never an account with no zones', async () => {
    await refreshAllVessels(context({ zones: null }));

    const rows = await database().db.select().from(vessels);
    const account = rows.find((row) => row.kind === 'cloudflare-account')!;

    expect(account.discovery?.zones).toBeNull();
    expect(account.discovery?.unreadable?.account).toContain(
      'no Cloudflare credential',
    );
  });
});
