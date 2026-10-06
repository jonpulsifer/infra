// The webhook route as mounted, over a real `Request`. The handler's own
// contract is tested in `test/integrations/github/webhook.test.ts`.
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { AdapterRegistry } from '../../src/commands/types.ts';
import type { Database } from '../../src/db/client.ts';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  deploys,
  repositories,
  targets,
} from '../../src/db/schema.ts';
import type {
  RepositorySourceStager,
  StagedSourceBundle,
} from '../../src/domain/source-bundle.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import {
  WEBHOOK_PATH,
  type WebhookRouteDeps,
  webhookRoutes,
} from '../../src/web/webhook-route.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import {
  SupplyChainHarness,
  testSignature,
} from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();
const SECRET = 'the installation’s webhook secret';
const NOW = new Date('2026-07-28T12:00:00.000Z');
const clock = { now: () => NOW };

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return `sha256=${Array.from(mac, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function delivery(
  event: string,
  payload: unknown,
  options: { signed?: boolean } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'X-GitHub-Event': event,
    'content-type': 'application/json',
  };
  if (options.signed !== false)
    headers['X-Hub-Signature-256'] = await sign(body);
  return new Request('https://spindrift.example.test/internal/github/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

/** Deps that throw when read, for deliveries refused before any read. */
const unreachable: WebhookRouteDeps = {
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error('reached the database');
      },
    },
  ) as Database,
  clock: {
    now: () => {
      throw new Error('read the clock');
    },
  },
  secret: async () => SECRET,
  current: () => {
    throw new Error('read installation state');
  },
};

function post(deps: WebhookRouteDeps, request: Request): Promise<Response> {
  return webhookRoutes(deps)[WEBHOOK_PATH]!(request);
}

class FakeSourceStager implements RepositorySourceStager {
  readonly staged: Array<{ repository: string; commit: string }> = [];

  async stageRepository(input: {
    readonly repository: string;
    readonly commit: string;
  }): Promise<StagedSourceBundle> {
    this.staged.push({ repository: input.repository, commit: input.commit });
    return {
      digest: `sha256:${'b'.repeat(64)}`,
      location: `gs://depot/${input.commit}.tgz`,
      retention: 'ephemeral',
    };
  }
}

describe('the route the earlier handler had nowhere to be reached from', () => {
  test('refuses a GET', async () => {
    const response = await post(
      unreachable,
      new Request('https://spindrift.example.test/internal/github/webhook'),
    );
    expect(response.status).toBe(405);
  });

  test('refuses every delivery when no secret is configured, before touching anything', async () => {
    const response = await post(
      { ...unreachable, secret: async () => null },
      await delivery('push', { ref: 'refs/heads/main' }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).failure.code).toBe('NOT_CONFIGURED');
  });

  test('refuses a bad signature before reading installation state', async () => {
    const response = await post(
      unreachable,
      await delivery('push', { ref: 'refs/heads/main' }, { signed: false }),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).failure.code).toBe('SIGNATURE_MISSING');
  });

  test('a verified delivery about nothing this installation manages is still a 202', async () => {
    const response = await post(
      {
        db: database().db,
        clock,
        secret: async () => SECRET,
        current: async () => ({
          adapters: {
            deploy: () => null,
            build: () => null,
            store: () => {
              throw new Error('unreachable: no App opted in');
            },
            repository: () => null,
            supplyChain: () => {
              throw new Error('unreachable: no App opted in');
            },
          } satisfies AdapterRegistry,
          manifest,
        }),
      },
      await delivery('push', {
        ref: 'refs/heads/main',
        after: '1'.repeat(40),
        repository: {
          full_name: 'example/unconnected',
          default_branch: 'main',
        },
      }),
    );
    expect(response.status).toBe(202);
    expect((await response.json()).value).toEqual({ classified: 'push' });
  });
});

describe('a push that reaches an opted-in App', () => {
  test('builds the commit that was pushed, and places no Deploy of the artifact built from an older one', async () => {
    const db = database().db;
    const stager = new FakeSourceStager();
    const fake = new FakeGitHub();
    const commit = fake.commitFiles('main', { 'README.md': 'hello' });

    const [repository] = await db
      .insert(repositories)
      .values({
        fullName: fake.fullName,
        installationId: fake.installationId,
        defaultBranch: fake.defaultBranch,
      })
      .returning();
    const [app] = await db
      .insert(apps)
      .values({
        name: 'invoices',
        sourceKind: 'repo',
        sourceRepoUrl: `https://git.invalid/${fake.fullName}`,
        repositoryId: repository!.id,
        autoDeploy: true,
      })
      .returning();
    const [component] = await db
      .insert(components)
      .values({ appId: app!.id, name: 'web', kind: 'service', expose: true })
      .returning();
    const vessel = await insertVessel(db, 'kubernetes', {
      name: `cluster-${crypto.randomUUID()}`,
    });
    const [target] = await db
      .insert(targets)
      .values(targetValues({ vesselId: vessel.id }))
      .returning();
    await db.insert(componentTargetDesired).values({
      componentId: component!.id,
      targetId: target!.id,
      updatedAt: NOW,
    });
    await db
      .update(components)
      .set({ placedTargetId: target!.id })
      .where(eq(components.id, component!.id));
    // Built from an older commit and deployable in every other respect, so only
    // the commit keeps the push from placing it.
    const digest = `sha256:${'a'.repeat(64)}`;
    const [build] = await db
      .insert(builds)
      .values({
        componentId: component!.id,
        commit: '0'.repeat(40),
        targetShape: 'image',
        artifactType: 'image',
        artifactDigest: digest,
        bundleDigest: digest,
        bundleLocation: 'https://depot.lolwtf.ca/bundles/1.zip',
        status: 'SUCCEEDED',
        verifiedBuildLevel: 2,
        signature: testSignature(digest, NOW.toISOString()),
        // The column defaults to the database's `now()`, which is later than
        // the frozen `NOW` the delivery writes at.
        createdAt: new Date(NOW.getTime() - 60_000),
      })
      .returning();
    expect(build).toBeDefined();

    const host = new GitHubApp({
      baseUrl: fake.baseUrl,
      authorization: () => 'Bearer test-installation-token',
      appAuthorization: () => 'Bearer test-app-jwt',
      fetch: fake.fetch,
    });
    const supplyChain = new SupplyChainHarness();
    const response = await post(
      {
        db,
        clock,
        secret: async () => SECRET,
        current: async () => ({
          adapters: {
            deploy: (adapter) =>
              adapter === 'kubernetes'
                ? new FakeDeployAdapter({ adapter })
                : null,
            build: () => null,
            source: () => stager,
            store: () => {
              throw new Error('unreachable: staging a bundle reads no secret');
            },
            repository: () => host,
            supplyChain: () => supplyChain,
          } satisfies AdapterRegistry,
          manifest,
        }),
      },
      await delivery('push', {
        ref: `refs/heads/${fake.defaultBranch}`,
        after: commit,
        repository: {
          full_name: fake.fullName,
          default_branch: fake.defaultBranch,
        },
      }),
    );

    expect(response.status).toBe(202);

    // The reconciliation reads the commit off the branch the delivery named.
    expect(stager.staged).toEqual([{ repository: fake.fullName, commit }]);

    // A `#<millis>` suffix on `commit` is the rerun uniqueness key.
    const rows = await db
      .select()
      .from(builds)
      .where(eq(builds.componentId, component!.id));
    expect(rows).toHaveLength(2);
    const pending = rows.find((row) => row.id !== build!.id);
    expect(pending?.status).toBe('PENDING');
    expect(pending?.commit.split('#')[0]).toBe(commit);

    const [desired] = await db
      .select()
      .from(componentTargetDesired)
      .where(eq(componentTargetDesired.componentId, component!.id));
    expect(desired?.desiredBuildId).toBeNull();
    expect(await db.select().from(deploys)).toHaveLength(0);
  });
});
