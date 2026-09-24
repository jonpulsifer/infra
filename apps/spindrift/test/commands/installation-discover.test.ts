/**
 * Installation discovery, through a real {@link createAdapterRegistry} against
 * a fake GCP. A refused probe answers `unavailable`, never an empty list.
 */
import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import {
  type DiscoveredFact,
  discoverInstallationFacts,
  HOME_VESSEL,
  placementOf,
} from '../../src/commands/installation/discover.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import type { Database } from '../../src/db/client.ts';
import { manifestFieldAt } from '../../src/web/forms/manifest.ts';
import {
  FakeGcpDiscovery,
  type FakeGcpDiscoveryOptions,
} from '../harness/fakes/gcp-discovery-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const TOKEN = 'a-federated-token';
const PROJECT = 'example-home';

const db = new Proxy(
  {},
  {
    get() {
      throw new Error('discovery reached the database');
    },
  },
) as Database;

const fixture = await fixtureManifest();

function manifestWith(
  federation: Partial<
    NonNullable<InstallationManifest['cloud']['federation']>
  > | null,
): InstallationManifest {
  return {
    ...fixture,
    cloud: {
      ...fixture.cloud,
      federation:
        federation === null
          ? null
          : { ...fixture.cloud.federation!, ...federation },
    },
  };
}

function contextFor(
  fake: FakeGcpDiscovery,
  manifest: InstallationManifest = manifestWith({}),
): CommandContext {
  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => new Date('2026-08-03T00:00:00.000Z') },
    db,
    manifest,
    adapters: createAdapterRegistry({
      manifest,
      env: {},
      // The fake refuses any request that does not carry this bearer token.
      cloudToken: () => TOKEN,
      fetch: fake.fetch,
    }),
  };
}

function installation(options: FakeGcpDiscoveryOptions = {}) {
  const fake = new FakeGcpDiscovery({ token: TOKEN, ...options });
  return { fake, context: contextFor(fake) };
}

/**
 * A discovered path names the home vessel by name; {@link placementOf} finds
 * its index in the document.
 */
const HOME = ['vessels', HOME_VESSEL] as const;

function factAt(
  facts: readonly DiscoveredFact[],
  ...path: (string | number)[]
): DiscoveredFact {
  const found = facts.find((fact) => fact.path.join('.') === path.join('.'));
  if (found === undefined) {
    throw new Error(`discovery answered nothing for ${path.join('.')}`);
  }
  return found;
}

async function discover(
  context: CommandContext,
  input: { project?: string; kmsLocation?: string } = {},
): Promise<readonly DiscoveredFact[]> {
  const result = await discoverInstallationFacts(input, context);
  if (!result.ok) {
    throw new Error(`discovery refused: ${result.failure.message}`);
  }
  return result.value.facts;
}

describe('a refusal is never an empty answer', () => {
  test('a disabled Storage API is unavailable, not a project with no buckets', async () => {
    const { context } = installation({
      projects: [PROJECT],
      refuse: {
        storage: {
          status: 403,
          reason: 'SERVICE_DISABLED',
          message: 'Cloud Storage API has not been used in this project',
        },
      },
    });

    const fact = factAt(
      await discover(context, { project: PROJECT }),
      'sources',
      'buckets',
    );

    expect(fact.kind).toBe('unavailable');
    // Assert the arm: `{ candidates: [] }` would still carry a plausible
    // message.
    expect(fact).not.toHaveProperty('candidates');
    expect(fact).not.toHaveProperty('suggested');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('Cloud Storage');
    expect(fact.reason).toContain(PROJECT);
    // A disabled API is a 403 like a missing grant, but its fix is a console
    // switch, so the reason must not send the operator to IAM.
    expect(fact.reason).toContain('not enabled');
    expect(fact.reason).not.toContain('may not list');
  });

  test('a disabled API is still read when only the message says so', async () => {
    // Some GCP calls put the reason in `error.details[].reason` and others only
    // in the message, so the fold matches both.
    const { context } = installation({
      projects: [PROJECT],
      refuse: {
        storage: {
          status: 403,
          message:
            'Cloud Storage API has not been used in project 1 before or it is disabled. SERVICE_DISABLED',
        },
      },
    });

    const fact = factAt(
      await discover(context, { project: PROJECT }),
      'sources',
      'buckets',
    );

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('not enabled');
    expect(fact.reason).not.toContain('may not list');
  });

  test('a disabled API names the consumer its ErrorInfo names, not the URL', async () => {
    // GCP checks the API switch in the project the token bills, and names that
    // consumer in ErrorInfo, which can differ from the project in the URL.
    const { context } = installation({
      projects: [PROJECT],
      refuse: {
        keyManagement: {
          status: 403,
          reason: 'SERVICE_DISABLED',
          consumer: 'example-billing',
          message: 'Cloud KMS API has not been used in project example-billing',
        },
      },
    });

    const fact = factAt(
      await discover(context, { project: PROJECT, kmsLocation: 'a-region' }),
      'supplyChain',
      'signer',
    );

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('not enabled in example-billing');
    expect(fact.reason).not.toContain(`not enabled in ${PROJECT}`);
  });

  test('a project with no buckets is found, with none', async () => {
    const { context } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: [] },
    });

    const fact = factAt(
      await discover(context, { project: PROJECT }),
      'sources',
      'buckets',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.candidates).toEqual([]);
    expect(fact.suggested).toBeNull();
  });

  test('one refused API does not refuse the others', async () => {
    const { context } = installation({
      projects: [PROJECT, 'example-artifacts'],
      buckets: { [PROJECT]: ['example-source-bucket'] },
      refuse: { keyManagement: { status: 403 } },
    });

    const facts = await discover(context, { project: PROJECT });

    expect(factAt(facts, ...HOME, 'shared', 'artifactsProject').kind).toBe(
      'found',
    );
    expect(factAt(facts, 'sources', 'buckets').kind).toBe('found');
    expect(factAt(facts, 'supplyChain', 'signer').kind).toBe('unavailable');
  });
});

describe('what the reads answer', () => {
  test('a bucket lands as a list and as the default, from one read', async () => {
    const { context, fake } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: ['example-source-bucket'] },
    });

    const facts = await discover(context, { project: PROJECT });
    const buckets = factAt(facts, 'sources', 'buckets');
    const fallback = factAt(facts, ...HOME, 'shared', 'sourceBucket');

    expect(buckets.kind).toBe('found');
    expect(fallback.kind).toBe('found');
    if (buckets.kind !== 'found' || fallback.kind !== 'found') return;
    expect(buckets.suggested).toEqual({
      label: 'example-source-bucket',
      value: ['example-source-bucket'],
    });
    expect(fallback.suggested).toEqual({
      label: 'example-source-bucket',
      value: 'example-source-bucket',
    });
    expect(
      fake.requests.filter((request) => request.path === '/storage/v1/b'),
    ).toHaveLength(1);
  });

  test('only a key that can sign is offered, as a gcpkms reference', async () => {
    const { context } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: [] },
      keys: [
        {
          project: PROJECT,
          location: 'a-region',
          ring: 'keys',
          name: 'signer',
        },
        {
          project: PROJECT,
          location: 'a-region',
          ring: 'keys',
          name: 'envelope',
          purpose: 'ENCRYPT_DECRYPT',
        },
      ],
    });

    const fact = factAt(
      await discover(context, { project: PROJECT, kmsLocation: 'a-region' }),
      'supplyChain',
      'signer',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.candidates.map((candidate) => candidate.value)).toEqual([
      `gcpkms://projects/${PROJECT}/locations/a-region/keyRings/keys/cryptoKeys/signer`,
    ]);
  });

  test('a signer with no location named says which locations there are', async () => {
    const { context } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: [] },
      keyLocations: { [PROJECT]: ['a-region', 'another-region'] },
    });

    const fact = factAt(
      await discover(context, { project: PROJECT }),
      'supplyChain',
      'signer',
    );

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('a-region');
    expect(fact.reason).toContain('another-region');
  });

  test('with no project named, nothing below one is guessed at', async () => {
    const { context, fake } = installation({ projects: [PROJECT] });

    const facts = await discover(context);

    expect(factAt(facts, ...HOME, 'shared', 'artifactsProject').kind).toBe(
      'found',
    );
    for (const path of [
      ['sources', 'buckets'],
      ['supplyChain', 'signer'],
    ]) {
      const fact = factAt(facts, ...path);
      expect(fact.kind).toBe('unavailable');
      if (fact.kind !== 'unavailable') continue;
      expect(fact.reason).toContain('name a project');
    }
    expect(fake.requests.map((request) => request.host)).toEqual([
      'cloudresourcemanager.googleapis.com',
    ]);
  });

  test('a project pending deletion is listed by the API and never offered', async () => {
    const { context } = installation({
      projects: [PROJECT],
      deletedProjects: ['example-retired'],
    });

    const fact = factAt(
      await discover(context),
      ...HOME,
      'shared',
      'artifactsProject',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.candidates.map((candidate) => candidate.value)).toEqual([
      PROJECT,
    ]);
  });
});

describe('truncation is not silence', () => {
  test('a paginated project list is walked to the end', async () => {
    const { context, fake } = installation({
      projects: [PROJECT, 'example-artifacts', 'example-vessel'],
      pageSize: 1,
    });

    const fact = factAt(
      await discover(context),
      ...HOME,
      'shared',
      'artifactsProject',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.candidates.map((candidate) => candidate.value)).toEqual([
      PROJECT,
      'example-artifacts',
      'example-vessel',
    ]);
    expect(fake.requests).toHaveLength(3);
  });

  test('a listing that will not end is refused, never cut short', async () => {
    // Past the page cap, a truncated list would read as complete.
    const { context, fake } = installation({
      projects: Array.from({ length: 30 }, (_, index) => `example-${index}`),
      pageSize: 1,
    });

    const fact = factAt(
      await discover(context),
      ...HOME,
      'shared',
      'artifactsProject',
    );

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('did not finish listing');
    expect(fake.requests.length).toBeLessThan(30);
  });

  test('more key rings than one pass will open is refused, not sampled', async () => {
    // `signingKeys` opens each ring with its own call, so this cap counts
    // rings.
    const { context } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: [] },
      keys: Array.from({ length: 30 }, (_, index) => ({
        project: PROJECT,
        location: 'a-region',
        ring: `ring-${index}`,
        name: 'signer',
      })),
    });

    const fact = factAt(
      await discover(context, { project: PROJECT, kmsLocation: 'a-region' }),
      'supplyChain',
      'signer',
    );

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('key rings');
  });
});

describe('the credential answers what it can without a call', () => {
  test('the impersonated identity suggests the home vessel', async () => {
    const fake = new FakeGcpDiscovery({ token: TOKEN, refuse: {} });
    const context = contextFor(
      fake,
      manifestWith({
        impersonationUrl: `https://iamcredentials.example.test/v1/projects/-/serviceAccounts/controller@${PROJECT}.iam.gserviceaccount.com:generateAccessToken`,
      }),
    );

    const fact = factAt(
      await discover(context),
      ...HOME,
      'location',
      'project',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.suggested?.value).toBe(PROJECT);
    expect(fact.suggested?.label).toContain('credential');
  });

  test('a project id at GCP’s longest is still read out of the identity', async () => {
    // GCP project ids run 6 to 30 characters.
    const longest = 'example-home-with-a-longer-nam';
    expect(longest).toHaveLength(30);
    const fake = new FakeGcpDiscovery({ token: TOKEN, refuse: {} });
    const context = contextFor(
      fake,
      manifestWith({
        impersonationUrl: `https://iamcredentials.example.test/v1/projects/-/serviceAccounts/controller@${longest}.iam.gserviceaccount.com:generateAccessToken`,
      }),
    );

    const fact = factAt(
      await discover(context),
      ...HOME,
      'location',
      'project',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.suggested?.value).toBe(longest);
  });

  test('an identity that is not a service account suggests nothing', async () => {
    // The fixture impersonates an address outside `iam.gserviceaccount.com`.
    const { context } = installation({ projects: [] });

    const fact = factAt(
      await discover(context),
      ...HOME,
      'location',
      'project',
    );

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.suggested).toBeNull();
    expect(fact.candidates).toEqual([]);
  });

  test('a suggestion survives a project list this identity may not read', async () => {
    // A narrowly granted identity often lacks `projects.list`, but its
    // credential still names its own project.
    const fake = new FakeGcpDiscovery({
      token: TOKEN,
      refuse: { resourceManager: { status: 403 } },
    });
    const context = contextFor(
      fake,
      manifestWith({
        impersonationUrl: `https://iamcredentials.example.test/v1/projects/-/serviceAccounts/controller@${PROJECT}.iam.gserviceaccount.com:generateAccessToken`,
      }),
    );

    const facts = await discover(context);
    const home = factAt(facts, ...HOME, 'location', 'project');

    expect(home.kind).toBe('found');
    if (home.kind !== 'found') return;
    // A refused listing still answers `found` here, so the label must name the
    // credential, or a 403 would read like a project the cloud confirmed.
    expect(home.candidates).toHaveLength(1);
    expect(home.candidates[0]?.label).toContain('credential');
    expect(home.candidates[0]?.value).toBe(PROJECT);
    expect(factAt(facts, ...HOME, 'shared', 'artifactsProject').kind).toBe(
      'unavailable',
    );
  });
});

describe('an installation with no cloud identity', () => {
  test('is refused as a fact, before a single request', async () => {
    const fake = new FakeGcpDiscovery({ token: TOKEN });
    const context = contextFor(fake, manifestWith(null));

    const result = await discoverInstallationFacts({}, context);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('this installation');
    expect(fake.requests).toEqual([]);
  });

  test('a registry that builds no discovery client is refused as a fact too', async () => {
    // `discovery` is optional on `AdapterRegistry`, so a hand-built registry
    // can omit it.
    const { context } = installation({ projects: [PROJECT] });

    const result = await discoverInstallationFacts(
      {},
      { ...context, adapters: { ...context.adapters, discovery: () => null } },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.code).toBe('NOT_DEPLOYABLE');
    expect(result.failure.message).toContain('this process');
  });
});

describe('every path discovery proposes is a path the manifest has', () => {
  /** Onboarding resolves its keys through the same `manifestFieldAt`. */
  function resolves(path: readonly (string | number)[]): boolean {
    return manifestFieldAt(path) !== null;
  }

  function placed(fact: DiscoveredFact): readonly (string | number)[] {
    const at = placementOf(fact, fixture);
    if (at === null) {
      throw new Error(`nothing in the fixture holds ${fact.path.join('.')}`);
    }
    return at;
  }

  test('the walk rejects a key the schema no longer has', () => {
    expect(resolves(['dns', 'apexZone'])).toBe(false);
    expect(resolves(['dns', 'zones', 0, 'name'])).toBe(true);
  });

  test('each answered path resolves to a real field', async () => {
    const { context } = installation({
      projects: [PROJECT],
      buckets: { [PROJECT]: ['example-source-bucket'] },
      keys: [
        {
          project: PROJECT,
          location: 'a-region',
          ring: 'keys',
          name: 'signer',
        },
      ],
    });

    const facts = await discover(context, {
      project: PROJECT,
      kmsLocation: 'a-region',
    });

    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      expect([fact.path.join('.'), resolves(placed(fact))]).toEqual([
        fact.path.join('.'),
        true,
      ]);
    }
  });

  test('a vessel path is placed by name, so an edited array cannot misplace it', async () => {
    // The settings form can remove `vessels` entries between discovery and
    // apply; `location.project` has no refinement to refuse a misplaced value.
    const { context } = installation({ projects: [PROJECT] });
    const fact = factAt(
      await discover(context, { project: PROJECT }),
      ...HOME,
      'location',
      'project',
    );

    const shifted = {
      ...fixture,
      vessels: [
        { name: 'a-boundary-added-since', kind: 'cluster' as const },
        ...fixture.vessels,
      ],
    };
    expect(placementOf(fact, shifted)).toEqual([
      'vessels',
      fixture.vessels.findIndex(
        (vessel) => vessel.name === fixture.installation.homeVessel,
      ) + 1,
      'location',
      'project',
    ]);
  });

  test('a document that declares no home vessel is placed nowhere', async () => {
    const { context } = installation({ projects: [PROJECT] });
    const fact = factAt(
      await discover(context, { project: PROJECT }),
      ...HOME,
      'location',
      'project',
    );

    expect(placementOf(fact, { ...fixture, vessels: [] })).toBeNull();
  });
});
