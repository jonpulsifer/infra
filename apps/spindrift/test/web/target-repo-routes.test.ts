import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { connectRepository } from '../../src/commands/repositories/connect.ts';
import { connectTarget } from '../../src/commands/targets/connect.ts';
import type {
  AdapterRegistry,
  CommandContext,
} from '../../src/commands/types.ts';
import * as schema from '../../src/db/schema.ts';
import { GitHubApp } from '../../src/integrations/github/app.ts';
import { commandRoutes, pathFor } from '../../src/web/dispatch.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import { FakeGitHub } from '../harness/fakes/github-api.ts';
import { clusterInput, fixtureManifest } from '../harness/installation.ts';

const database = withIsolatedDatabase();
const NOW = new Date('2026-07-28T12:00:00.000Z');

async function makeContext(
  fakeGithub: FakeGitHub | null,
): Promise<CommandContext> {
  const host =
    fakeGithub === null
      ? null
      : new GitHubApp({
          baseUrl: fakeGithub.baseUrl,
          authorization: () => 'Bearer test-user-token',
          fetch: fakeGithub.fetch,
        });

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
    // The requirements travel in the payload, so options over the route
    // boundary is only exercised when the caller states what it is placing.
    const res = await routes[pathFor('listTargets')]!(
      post(pathFor('listTargets'), {
        kind: 'service',
        reach: 'private',
        auth: 'proxy',
      }),
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

  test('listTargets reports prerequisite failure details for unhealthy targets over HTTP', async () => {
    const ctx = await makeContext(null);
    await connectTarget(clusterInput({ name: 'unhealthy-cluster' }), ctx);

    await ctx.db
      .update(schema.targets)
      .set({
        health: 'unhealthy',
        prerequisites: [
          {
            name: 'DELIVERY_OPERATOR',
            met: false,
            detail: 'API server unreachable at https://10.0.0.1:6443',
          },
        ],
      })
      .where(eq(schema.targets.name, 'unhealthy-cluster'));

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
    expect(body.value.targets[0].health).toBe('unhealthy');
    expect(body.value.targets[0].prerequisiteFailures).toEqual([
      'API server unreachable at https://10.0.0.1:6443',
    ]);
  });

  test('listRepositories returns connected repos and options for authenticated user', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const ctx = await makeContext(fake);

    await connectRepository(
      {
        fullName: fake.fullName,
        overrides: [
          {
            scope: 'app',
            kind: 'service',
            build: {
              frontend: 'railpack',
              buildCommand: 'bun run build',
              outputDirectory: null,
            },
            watchPaths: ['app'],
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

  test('listRepositories reports connection_lost and error message for frozen repositories over HTTP', async () => {
    const fake = new FakeGitHub();
    fake.commitFiles('main', { 'README.md': 'unconnected' });
    const ctx = await makeContext(fake);

    await connectRepository(
      {
        fullName: fake.fullName,
        overrides: [
          {
            scope: 'app',
            kind: 'service',
            build: {
              frontend: 'railpack',
              buildCommand: 'bun run build',
              outputDirectory: null,
            },
            watchPaths: ['app'],
          },
        ],
      },
      ctx,
    );

    await ctx.db
      .update(schema.repositories)
      .set({
        access: 'frozen',
        frozenReason: 'GitHub App installation was suspended or uninstalled',
      })
      .where(eq(schema.repositories.fullName, fake.fullName));

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
    expect(body.value.repos[0].health).toBe('connection_lost');
    expect(body.value.repos[0].error).toBe(
      'GitHub App installation was suspended or uninstalled',
    );
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
