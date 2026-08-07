/**
 * The standing checklist a boundary is assessed against.
 *
 * The claim is the one `cloud-discovery.ts` states and nothing acted on until
 * this loop: "a mistyped project or bucket is invisible until a build stages a
 * source archive and fails on a signed URL". A red row on a screen is what turns
 * that into something an operator can see before a build.
 *
 * The far side is faked at the HTTP seam (§ Seam 2), so the real client, its
 * real resource names and its real key-purpose filter all run — which is what
 * makes "the signer is not a signing key here" a fact this suite can produce
 * rather than one it can only stub.
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

/** The home vessel as this suite declares it: a project with a signer in it. */
const HOME_PROJECT = 'example-vessel';
const SIGNER_LOCATION = 'example-region';

/**
 * The fixture installation with the home vessel actually located somewhere.
 *
 * The document ships without a `location` on either boundary — that half-ready
 * state is one §13 intends to be visible — and a checklist against a project
 * nobody stated is the one answer this loop must not fabricate. So the tests
 * that assert a green row supply one, and the test that asserts the honest
 * refusal leaves it off.
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

/** A store that answers a listing, or refuses the way an unreachable one does. */
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
  const adapters: Pick<AdapterRegistry, 'discovery' | 'store'> = {
    discovery: () => (wiring.discovery === null ? null : real.discovery!()),
    store: () => store(wiring.storeReachable ?? true),
  };
  return { db: database().db, clock: { now: () => NOW }, adapters, manifest };
}

/** The checklist for the home vessel, keyed so a row is read by name. */
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
  return new Map(answered.map((item) => [item.name, item]));
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
    // The exact failure this exists for: a mistyped bucket, said out loud on a
    // screen instead of at a signed URL minutes into a build.
    const checklist = await homeChecklist({
      discovery: { buckets: { [HOME_PROJECT]: ['some-other-bucket'] } },
    });
    const bucket = checklist.get('SOURCE_BUCKET')!;
    expect(bucket.met).toBe(false);
    expect(bucket.detail).toContain('example-source-bucket');
    // And only that row: three independent reads, so one absence is not four.
    expect(checklist.get('SIGNER_KEY')?.met).toBe(true);
    expect(checklist.get('ARTIFACTS_PROJECT')?.met).toBe(true);
  });

  test('a refused read is a different sentence from an absence', async () => {
    // `cloud-discovery.ts`'s rule, carried all the way to the row: a `403` says
    // nothing was established, and reporting it as "your bucket is not there"
    // would put a confident absence on screen off a failed read.
    const checklist = await homeChecklist({
      discovery: { refuse: { storage: { status: 403, message: 'no' } } },
    });
    const bucket = checklist.get('SOURCE_BUCKET')!;
    expect(bucket.met).toBe(false);
    expect(bucket.detail).toContain('may not list');
    expect(bucket.detail).not.toContain('is not a bucket');
  });

  test('a key of the wrong purpose is not a signer', async () => {
    // Run through the real filter: a symmetric key produces a `signer` that
    // validates, saves, reconciles, and fails at the first cosign call.
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
    // Rather than a probe against `projects/undefined` and a sentence naming
    // `undefined` back to the operator.
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

    // Every vessel, not only the two the installation is built on: an app
    // vessel's pass is one write of an empty checklist, and that empty list is
    // what makes assessed-and-asked-nothing a stored state of its own.
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
    // Assessed and asked nothing, which is a different stored state from never
    // assessed — and never a green row for something nobody checked.
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

    // The first pass has nothing to compare against — never assessed is not a
    // verdict that changed.
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
    // The whole reason a remediation is a pull request and not a mutation. The
    // change is applied by whatever applies Terraform; nothing tells this loop
    // that it was, and nothing has to — the next pass reads the boundary again
    // and the row moves on its own. There is no recheck act in this test
    // because there is none in the product.
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

    // The boundary now holds what the stanza would have declared.
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
    // And the row still carries only what was observed: what would have cleared
    // it is composed when somebody reads the checklist, never written here.
    for (const item of row.prerequisites ?? []) {
      expect(item.remediation).toBeUndefined();
    }
  });
});
