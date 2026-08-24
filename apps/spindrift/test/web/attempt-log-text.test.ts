/**
 * The attempt log as one `text/plain` document (§21: transport, no domain
 * logic).
 *
 * Two claims: the route sits behind exactly the session gate the attempt
 * stream does — an anonymous read is refused before a context exists — and
 * what an authenticated read gets is the whole log, in order, one line per
 * row, with status events bracketed so the document says where each leg ended.
 */
import { describe, expect, test } from 'bun:test';
import type { CommandContext } from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  deploys,
  targets,
  users,
} from '../../src/db/schema.ts';
import {
  recordBuildEvent,
  recordDeployEvent,
} from '../../src/domain/attempt-log.ts';
import {
  ATTEMPT_LOG_TEXT_PATH,
  attemptLogTextRoutes,
} from '../../src/web/streams.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { FakeDeployAdapter } from '../harness/fakes/deploy-adapter.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();

async function seedAttempt() {
  const db = database().db;
  const [user] = await db
    .insert(users)
    .values({ displayName: 'Operator' })
    .returning();
  const [app] = await db
    .insert(apps)
    .values({ name: 'live-app', sourceKind: 'repo' })
    .returning();
  const [component] = await db
    .insert(components)
    .values({ appId: app!.id, name: 'web', kind: 'service' })
    .returning();
  const vessel = await insertVessel(db, 'kubernetes', { name: 'cluster' });
  const [target] = await db
    .insert(targets)
    .values(targetValues({ vesselId: vessel.id }))
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abc123',
      targetShape: 'image',
      artifactType: 'image',
    })
    .returning();
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: component!.id,
      desired: aDesiredDocument(),
      targetId: target!.id,
      buildId: build!.id,
    })
    .returning();
  const scope = { appId: app!.id, componentId: component!.id };
  await recordBuildEvent(
    db,
    { ...scope, buildId: build!.id },
    { type: 'log', line: 'compile one' },
  );
  await recordBuildEvent(
    db,
    { ...scope, buildId: build!.id },
    { type: 'status', phase: 'SUCCEEDED' },
  );
  await recordDeployEvent(
    db,
    { ...scope, deployId: deploy!.id },
    { type: 'log', line: 'applying' },
  );
  await recordDeployEvent(
    db,
    { ...scope, deployId: deploy!.id },
    { type: 'status', phase: 'LIVE', resource: 'Deployment/web' },
  );
  return {
    principal: { id: user!.id, displayName: user!.displayName },
    scope,
    build: build!,
    deploy: deploy!,
  };
}

async function context(principal: {
  id: string;
  displayName: string;
}): Promise<CommandContext> {
  return {
    principal,
    clock: { now: () => new Date('2026-08-23T12:00:00Z') },
    db: database().db,
    adapters: {
      deploy: () => new FakeDeployAdapter(),
      build: () => null,
      store: () => null,
      repository: () => null,
      supplyChain: () => {
        throw new Error('the plain-text log does not use supply chain');
      },
    },
    manifest: await fixtureManifest(),
  };
}

function request(query: string) {
  return new Request(
    `https://spindrift.example.test${ATTEMPT_LOG_TEXT_PATH}?${query}`,
  );
}

const ISO = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z';

describe('the plain-text attempt log', () => {
  test('refuses an anonymous read before constructing a context', async () => {
    const routes = attemptLogTextRoutes({
      authenticate: async () => ({ kind: 'anonymous' }),
      context: () => {
        throw new Error('an anonymous read constructed a context');
      },
    });

    const response = await routes[ATTEMPT_LOG_TEXT_PATH]!(request('buildId=1'));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      failure: { code: 'UNAUTHENTICATED' },
    });
  });

  test('serves both legs of an attempt, in order, as text', async () => {
    const seeded = await seedAttempt();
    const ctx = await context(seeded.principal);
    const routes = attemptLogTextRoutes({
      authenticate: async () => ({
        kind: 'authenticated',
        principal: seeded.principal,
      }),
      context: () => ctx,
    });

    const response = await routes[ATTEMPT_LOG_TEXT_PATH]!(
      request(`buildId=${seeded.build.id}&deployId=${seeded.deploy.id}`),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/plain; charset=utf-8',
    );
    expect(response.headers.get('content-disposition')).toBe(
      `inline; filename="web-deploy-${seeded.deploy.id}.txt"`,
    );
    const lines = (await response.text()).split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('compile one');
    expect(lines[1]).toMatch(new RegExp(`^\\[${ISO} build SUCCEEDED\\]$`));
    expect(lines[2]).toBe('applying');
    expect(lines[3]).toMatch(
      new RegExp(`^\\[${ISO} deploy LIVE Deployment/web\\]$`),
    );
    // One line per row, and a newline after the last of them.
    expect(lines[4]).toBe('');
  });

  test('a Build alone is the build leg, named as such', async () => {
    const seeded = await seedAttempt();
    const ctx = await context(seeded.principal);
    const routes = attemptLogTextRoutes({
      authenticate: async () => ({
        kind: 'authenticated',
        principal: seeded.principal,
      }),
      context: () => ctx,
    });

    const response = await routes[ATTEMPT_LOG_TEXT_PATH]!(
      request(`buildId=${seeded.build.id}`),
    );
    expect(response.headers.get('content-disposition')).toBe(
      `inline; filename="web-build-${seeded.build.id}.txt"`,
    );
    const text = await response.text();
    expect(text.startsWith('compile one\n[')).toBe(true);
    expect(text).not.toContain('applying');
  });

  test('reads past one page of the stream', async () => {
    const seeded = await seedAttempt();
    await database()
      .db.insert(attemptEvents)
      .values(
        Array.from({ length: 700 }, (_, index) => ({
          ...seeded.scope,
          attemptKind: 'build' as const,
          buildId: seeded.build.id,
          eventType: 'log' as const,
          line: `line ${index}`,
        })),
      );
    const ctx = await context(seeded.principal);
    const routes = attemptLogTextRoutes({
      authenticate: async () => ({
        kind: 'authenticated',
        principal: seeded.principal,
      }),
      context: () => ctx,
    });

    const response = await routes[ATTEMPT_LOG_TEXT_PATH]!(
      request(`buildId=${seeded.build.id}`),
    );
    const lines = (await response.text()).trimEnd().split('\n');
    // The two seeded build rows, then every one of the seven hundred.
    expect(lines).toHaveLength(702);
    expect(lines.at(-1)).toBe('line 699');
  });

  test('a Build that does not exist is not found', async () => {
    const seeded = await seedAttempt();
    const ctx = await context(seeded.principal);
    const routes = attemptLogTextRoutes({
      authenticate: async () => ({
        kind: 'authenticated',
        principal: seeded.principal,
      }),
      context: () => ctx,
    });

    const response = await routes[ATTEMPT_LOG_TEXT_PATH]!(
      request('buildId=999999'),
    );
    expect(response.status).toBe(404);
  });
});
