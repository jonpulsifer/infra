import { describe, expect, test } from 'bun:test';
import { connectRepository } from '../../src/commands/repositories/connect.ts';
import { connectTarget } from '../../src/commands/targets/connect.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { commandRoutes, pathFor } from '../../src/web/dispatch.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub, testAppKey } from '../harness/fakes/github-api.ts';
import { clusterInput, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const NOW = new Date('2026-07-28T12:00:00.000Z');

async function makeContext(
  fakeGithub: FakeGitHub | null,
): Promise<CommandContext> {
  const { pem } = await testAppKey();
  const host =
    fakeGithub === null
      ? null
      : new GitHubApp(
          {
            appId: '1234567',
            privateKeyPem: pem,
            baseUrl: fakeGithub.baseUrl,
            fetch: fakeGithub.fetch,
          },
          () => NOW,
        );

  const fakeDeploy = new FakeDeployAdapter({ adapter: 'kubernetes' });
  const adapters: AdapterRegistry = {
    deploy: () => fakeDeploy,
    build: () => null,
    store: () => {
      throw new Error('no store adapter in test');
    },
    repository: () => host,
    supplyChain: () => {
      throw new Error('no supply chain in test');
    },
  };

  return {
    principal: { id: 'user-1', displayName: 'Operator' },
    clock: { now: () => NOW },
    db: database().db,
    adapters,
    manifest: await fixtureManifest(),
  };
}

function serve(ctx: CommandContext, authenticated = true) {
  const deps = {
    authenticate: async () =>
      authenticated
        ? { kind: 'authenticated' as const, principal: ctx.principal }
        : { kind: 'anonymous' as const },
    context: () => ctx,
  };
  return commandRoutes(deps);
}

function post(path: string, body: unknown = {}): Request {
  return new Request(`https://spindrift.example.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('listTargets and listRepositories over route boundary', () => {
  test('listTargets over HTTP returns 401 when unauthenticated', async () => {
    const ctx = await makeContext(null);
    const routes = serve(ctx, false);
    const res = await routes[pathFor('listTargets')]!(
      post(pathFor('listTargets'), {}),
    );
    expect(res.status).toBe(401);
  });

  test('listRepositories over HTTP returns 401 when unauthenticated', async () => {
    const ctx = await makeContext(null);
    const routes = serve(ctx, false);
    const res = await routes[pathFor('listRepositories')]!(
      post(pathFor('listRepositories'), {}),
    );
    expect(res.status).toBe(401);
  });

  test('listTargets returns persisted targets and options for authenticated user', async () => {
    const ctx = await makeContext(null);
    await connectTarget(clusterInput({ name: 'folly-cluster' }), ctx);

    const routes = serve(ctx, true);
    const res = await routes[pathFor('listTargets')]!(
      post(pathFor('listTargets'), {}),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      value: { targets: any[]; options: any[] };
    };
    expect(body.ok).toBe(true);
    expect(body.value.targets).toHaveLength(1);
    expect(body.value.targets[0].name).toBe('folly-cluster');
    expect(body.value.options).toHaveLength(1);
    expect(body.value.options[0].name).toBe('folly-cluster');
  });

  test('listRepositories returns connected repos and options for authenticated user', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const ctx = await makeContext(fake);

    await connectRepository(
      {
        fullName: fake.fullName,
        installationId: fake.installationId,
        scopes: [
          {
            scope: 'app',
            proposal: {
              source: 'railpack',
              kind: 'service',
              kinds: [{ kind: 'service', available: true }],
              build: {
                frontend: 'railpack',
                buildCommand: 'bun run build',
                outputDirectory: null,
              },
              watchPaths: [],
            },
          },
        ],
      },
      ctx,
    );

    const routes = serve(ctx, true);
    const res = await routes[pathFor('listRepositories')]!(
      post(pathFor('listRepositories'), {}),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      value: { repos: any[]; options: any[] };
    };
    expect(body.ok).toBe(true);
    expect(body.value.repos).toHaveLength(1);
    expect(body.value.repos[0].fullName).toBe(fake.fullName);
    expect(body.value.options).toHaveLength(1);
    expect(body.value.options[0].fullName).toBe(fake.fullName);
  });

  test('empty installation returns empty lists without falling back to sample data', async () => {
    const ctx = await makeContext(null);
    const routes = serve(ctx, true);

    const targetRes = await routes[pathFor('listTargets')]!(
      post(pathFor('listTargets'), {}),
    );
    const targetBody = (await targetRes.json()) as {
      ok: boolean;
      value: { targets: any[]; options: any[] };
    };
    expect(targetBody.ok).toBe(true);
    expect(targetBody.value.targets).toEqual([]);

    const repoRes = await routes[pathFor('listRepositories')]!(
      post(pathFor('listRepositories'), {}),
    );
    const repoBody = (await repoRes.json()) as {
      ok: boolean;
      value: { repos: any[]; options: any[] };
    };
    expect(repoBody.ok).toBe(true);
    expect(repoBody.value.repos).toEqual([]);
  });
});
