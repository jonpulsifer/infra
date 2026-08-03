/**
 * Discovering what an operator would otherwise type (§13, §20).
 *
 * The claim under test is one sentence: **a refusal is not an empty list.** A
 * confirmation screen showing "buckets: none" is an answer an operator will act
 * on, and producing it from a `403`, a switched-off API or an unreachable
 * network is worse than producing nothing — it launders a failed probe into a
 * fact. So the assertions below are about the *arm* an answer came back in, not
 * about the wording of a message, and the first three fail if that distinction
 * is ever collapsed.
 *
 * Driven through a real {@link createAdapterRegistry} against a fake far side,
 * per § Seam 2. The registry is not incidental: the whole point of discovery
 * living there is that it shares the one federated provider the cloud deploy
 * adapters use, so a test that handed the command a hand-built client would
 * prove the fold and none of the wiring.
 */
import { describe, expect, test } from 'bun:test';
import { createAdapterRegistry } from '../../src/adapters/registry.ts';
import {
  type DiscoveredFact,
  discoverInstallationFacts,
} from '../../src/commands/installation/discover.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { installationManifestSchema } from '../../src/config/manifest.schema.ts';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import type { Database } from '../../src/db/client.ts';
import { describeObject, type FormField } from '../../src/web/forms/schema.ts';
import {
  FakeGcpDiscovery,
  type FakeGcpDiscoveryOptions,
} from '../harness/fakes/gcp-discovery-api.ts';
import { fixtureManifest } from '../harness/installation.ts';

const TOKEN = 'a-federated-token';
const PROJECT = 'example-home';

/**
 * A database that fails if it is touched.
 *
 * Discovery reads the cloud and writes nothing — confirming a value is
 * `configureInstallation`'s act, not this one's — and a fixture row here would
 * only be a way for that to stop being true unnoticed.
 */
const db = new Proxy(
  {},
  {
    get() {
      throw new Error('discovery reached the database');
    },
  },
) as Database;

const fixture = await fixtureManifest();

/** The fixture installation, with whatever federation a test needs. */
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
      // The credential the registry hands every cloud client. Injected here so
      // the fake can assert which one arrived, exactly as the token exchange
      // would have minted it.
      cloudToken: () => TOKEN,
      fetch: fake.fetch,
    }),
  };
}

/** Everything wired for one run: a fake far side and a context over it. */
function installation(options: FakeGcpDiscoveryOptions = {}) {
  const fake = new FakeGcpDiscovery({ token: TOKEN, ...options });
  return { fake, context: contextFor(fake) };
}

/** One fact by the manifest path it proposes a value for. */
function factAt(
  facts: readonly DiscoveredFact[],
  ...path: string[]
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
    // On the arm, not on the sentence. A regression that answered
    // `{ candidates: [] }` here would still carry a plausible message; what it
    // could not do is stop having candidates at all.
    expect(fact).not.toHaveProperty('candidates');
    expect(fact).not.toHaveProperty('suggested');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('Cloud Storage');
    expect(fact.reason).toContain(PROJECT);
    // Which refusal, not just that there was one. A disabled API arrives as a
    // `403` like a missing grant does, and telling an operator they lack a
    // permission they already hold sends them to write IAM policy for a switch
    // in a console. The sentence has to be the console's.
    expect(fact.reason).toContain('not enabled');
    expect(fact.reason).not.toContain('may not list');
  });

  test('a disabled API is still read when only the message says so', async () => {
    // The other shape the same fact arrives in: these APIs put the reason in
    // `error.details[].reason` on some calls and only in the message on
    // others, which is why the fold matches the body as well as the parsed
    // reason. One of the two halves being unbacked is one half of operators
    // being told to fix a permission that is correct.
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

    expect(factAt(facts, 'cloud', 'artifactsProject').kind).toBe('found');
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
    const fallback = factAt(facts, 'sources', 'defaultBucket');

    expect(buckets.kind).toBe('found');
    expect(fallback.kind).toBe('found');
    if (buckets.kind !== 'found' || fallback.kind !== 'found') return;
    // The same name, in the two shapes the two keys take. A screen deriving
    // that would be a screen with an opinion about the schema.
    expect(buckets.suggested).toEqual({
      label: 'example-source-bucket',
      value: ['example-source-bucket'],
    });
    expect(fallback.suggested).toEqual({
      label: 'example-source-bucket',
      value: 'example-source-bucket',
    });
    // One read, not two: both keys are answered from a single bucket listing.
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
    // The URI is the prefix plus the key's own resource name, verbatim —
    // assembling the six segments by hand is where a typo becomes a signing
    // failure nothing catches until a build.
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

    expect(factAt(facts, 'cloud', 'artifactsProject').kind).toBe('found');
    for (const path of [
      ['sources', 'buckets'],
      ['supplyChain', 'signer'],
    ]) {
      const fact = factAt(facts, ...path);
      expect(fact.kind).toBe('unavailable');
      if (fact.kind !== 'unavailable') continue;
      expect(fact.reason).toContain('name a project');
    }
    // Stated rather than probed: no project means no call that needed one.
    expect(fake.requests.map((request) => request.host)).toEqual([
      'cloudresourcemanager.googleapis.com',
    ]);
  });

  test('a project pending deletion is listed by the API and never offered', async () => {
    const { context } = installation({
      projects: [PROJECT],
      deletedProjects: ['example-retired'],
    });

    const fact = factAt(await discover(context), 'cloud', 'artifactsProject');

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

    const fact = factAt(await discover(context), 'cloud', 'artifactsProject');

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    // A single-page read answers one plausible project and reads as complete.
    expect(fact.candidates.map((candidate) => candidate.value)).toEqual([
      PROJECT,
      'example-artifacts',
      'example-vessel',
    ]);
    expect(fake.requests).toHaveLength(3);
  });

  test('a listing that will not end is refused, never cut short', async () => {
    // The cap earns its place only if hitting it says so. A `break` here would
    // answer twenty projects out of thirty as a complete list — the same defect
    // as an empty answer, wearing a plausible number.
    const { context, fake } = installation({
      projects: Array.from({ length: 30 }, (_, index) => `example-${index}`),
      pageSize: 1,
    });

    const fact = factAt(await discover(context), 'cloud', 'artifactsProject');

    expect(fact.kind).toBe('unavailable');
    if (fact.kind !== 'unavailable') return;
    expect(fact.reason).toContain('did not finish listing');
    // And it stopped asking, rather than walking all thirty pages anyway.
    expect(fake.requests.length).toBeLessThan(30);
  });

  test('more key rings than one pass will open is refused, not sampled', async () => {
    // Same rule one API over: `signingKeys` opens each ring with its own call,
    // so the cap is on rings rather than pages — and a signer list built from
    // the first twenty rings of thirty is a manifest that validates and then
    // fails at the first cosign call.
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

    const fact = factAt(await discover(context), 'cloud', 'homeVesselProject');

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    // The project is what gets written; where it came from is what gets read.
    expect(fact.suggested?.value).toBe(PROJECT);
    expect(fact.suggested?.label).toContain('credential');
  });

  test('a project id at GCP’s longest is still read out of the identity', async () => {
    // The bound, exactly: GCP project ids run 6 to 30 characters, and a regex
    // one short at the top silently stops suggesting anything for the longest
    // legal name — a wrong answer that looks like "this credential says
    // nothing".
    const longest = 'example-home-with-a-longer-nam';
    expect(longest).toHaveLength(30);
    const fake = new FakeGcpDiscovery({ token: TOKEN, refuse: {} });
    const context = contextFor(
      fake,
      manifestWith({
        impersonationUrl: `https://iamcredentials.example.test/v1/projects/-/serviceAccounts/controller@${longest}.iam.gserviceaccount.com:generateAccessToken`,
      }),
    );

    const fact = factAt(await discover(context), 'cloud', 'homeVesselProject');

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.suggested?.value).toBe(longest);
  });

  test('an identity that is not a service account suggests nothing', async () => {
    // The fixture's own credential impersonates a host that is not a service
    // account address. A partial match must yield nothing rather than a
    // fragment of a project name presented as an answer.
    const { context } = installation({ projects: [] });

    const fact = factAt(await discover(context), 'cloud', 'homeVesselProject');

    expect(fact.kind).toBe('found');
    if (fact.kind !== 'found') return;
    expect(fact.suggested).toBeNull();
    expect(fact.candidates).toEqual([]);
  });

  test('a suggestion survives a project list this identity may not read', async () => {
    // The likely live posture: an identity granted on one bucket and one key is
    // not usually granted `projects.list`. The credential still knows its own
    // project, and losing that to a refusal elsewhere would be discovery
    // refusing a question it had already answered.
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
    const home = factAt(facts, 'cloud', 'homeVesselProject');

    expect(home.kind).toBe('found');
    if (home.kind !== 'found') return;
    // This is the one place the two arms are crossed — a refused listing comes
    // back `found` — so the candidate has to say where it came from. Without
    // that, a `403` on `projects.list` reads on the screen exactly like a
    // project the cloud confirmed, which is the laundering the arms exist for.
    expect(home.candidates).toHaveLength(1);
    expect(home.candidates[0]?.label).toContain('credential');
    expect(home.candidates[0]?.value).toBe(PROJECT);
    // And the key it cannot suggest anything for stays honest about the same
    // refusal, rather than borrowing the answer.
    expect(factAt(facts, 'cloud', 'artifactsProject').kind).toBe('unavailable');
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
    // Proven rather than described: nothing was asked, so nothing failed.
    expect(fake.requests).toEqual([]);
  });

  test('a registry that builds no discovery client is refused as a fact too', async () => {
    // `discovery` is optional on `AdapterRegistry` for the reason the four
    // lookups above it are — a hand-built registry omits what it has no opinion
    // about — so the absent case is reachable and is a different sentence from
    // the absent-federation one above. A process that cannot reach a cloud API
    // is a fact about the process, not about the manifest.
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
  /** Walk the schema the settings form is generated from, key by key. */
  function resolves(path: readonly string[]): boolean {
    let fields: readonly FormField[] = describeObject(
      installationManifestSchema,
    );
    for (const [index, key] of path.entries()) {
      const field = fields.find((candidate) => candidate.key === key);
      if (field === undefined) return false;
      if (index === path.length - 1) return true;
      if (field.node.kind !== 'object') return false;
      fields = field.node.fields;
    }
    return false;
  }

  test('the walk rejects a key the schema no longer has', () => {
    // The exact staleness this test exists to catch: `dns.apexZone` was the
    // key when discovery was first specified, and `dns.zones.private` is the
    // key now. A detector nobody has seen fail is not a detector.
    expect(resolves(['dns', 'apexZone'])).toBe(false);
    expect(resolves(['dns', 'zones', 'private'])).toBe(true);
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
      expect([fact.path.join('.'), resolves(fact.path)]).toEqual([
        fact.path.join('.'),
        true,
      ]);
    }
  });
});
