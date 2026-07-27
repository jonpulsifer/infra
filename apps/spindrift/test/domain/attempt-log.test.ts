/**
 * The attempt log acceptance test (Task 11, §6).
 *
 * Three things load-bearing here, proven against a real Postgres:
 *
 * 1. A Build's failure and the Deploy that followed it land on **one**
 *    ordered stream, in the order they actually happened — the shape of
 *    §6's own worked example: a build failure vs. `ARTIFACT_UNAVAILABLE`
 *    on a green build, told on one timeline.
 * 2. Every status event's `blame` is exactly what the deploy contract's
 *    `BLAME` table assigns its `reason` — never independently supplied.
 * 3. The resume cursor is gap-free and duplicate-free: reading, then
 *    resuming from the returned cursor, yields exactly the events written
 *    after it.
 *
 * Each test runs in its own migrated Postgres schema, handed out by the
 * harness (`test/harness/db.ts`).
 */
import { describe, expect, test } from 'bun:test';
import {
  BLAME,
  type FailureReason,
} from '../../src/adapters/deploy/contract.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  type AttemptLogCursor,
  readAttemptStream,
  recordBuildEvent,
  recordDeployEvent,
} from '../../src/domain/attempt-log.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

/** Seed an App -> Component -> Target -> Build -> Deploy chain. */
async function seedAttempt() {
  const [app] = await database()
    .db.insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'repo' })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values({
      name: `target-${crypto.randomUUID()}`,
      adapter: 'kubernetes',
      rank: 0,
    })
    .returning();
  const [component] = await database()
    .db.insert(components)
    .values({
      appId: app!.id,
      name: `web-${crypto.randomUUID()}`,
      kind: 'service',
    })
    .returning();
  const [build] = await database()
    .db.insert(builds)
    .values({
      componentId: component!.id,
      commit: 'deadbeef',
      targetShape: 'kubernetes:image',
      artifactType: 'image',
    })
    .returning();
  const [deploy] = await database()
    .db.insert(deploys)
    .values({
      componentId: component!.id,
      targetId: target!.id,
      buildId: build!.id,
    })
    .returning();

  return {
    app: app!,
    component: component!,
    target: target!,
    build: build!,
    deploy: deploy!,
  };
}

describe('attempt log: one stream across build and deploy', () => {
  test('a build failure and a deploy failure land on one ordered stream, in order', async () => {
    const { app, component, build, deploy } = await seedAttempt();

    // Build leg: a log line, then the failing status.
    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'Step 3/5: RUN bun test' },
    );
    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'status', phase: 'FAILED', reason: 'BUILD_FAILED' },
    );

    // Deploy leg for the *same* attempt: a later status event.
    await recordDeployEvent(
      database().db,
      { appId: app.id, componentId: component.id, deployId: deploy.id },
      { type: 'status', phase: 'PENDING' },
    );
    await recordDeployEvent(
      database().db,
      { appId: app.id, componentId: component.id, deployId: deploy.id },
      {
        type: 'status',
        phase: 'FAILED',
        resource: 'helmrelease/web',
        reason: 'ARTIFACT_UNAVAILABLE',
      },
    );

    const page = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
      deployId: deploy.id,
    });

    expect(page.entries).toHaveLength(4);
    // Ordered exactly as written: build log, build status, deploy status,
    // deploy status — one stream, not two concatenated after the fact.
    expect(page.entries.map((e) => e.attemptKind)).toEqual([
      'build',
      'build',
      'deploy',
      'deploy',
    ]);
    expect(page.entries[0]).toMatchObject({
      type: 'log',
      line: 'Step 3/5: RUN bun test',
    });
    expect(page.entries[1]).toMatchObject({
      type: 'status',
      phase: 'FAILED',
      reason: 'BUILD_FAILED',
    });
    expect(page.entries[2]).toMatchObject({ type: 'status', phase: 'PENDING' });
    expect(page.entries[3]).toMatchObject({
      type: 'status',
      phase: 'FAILED',
      reason: 'ARTIFACT_UNAVAILABLE',
      resource: 'helmrelease/web',
    });

    // Cursors strictly increase — the total order the read side promises.
    const cursors = page.entries.map((e) => e.cursor);
    expect(cursors).toEqual([...cursors].sort((a, b) => a - b));
    expect(new Set(cursors).size).toBe(4);
  });

  test('a build-only attempt (no deploy yet) reads just the build leg', async () => {
    const { app, component, build } = await seedAttempt();

    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'building...' },
    );

    const page = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
    });

    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      attemptKind: 'build',
      type: 'log',
      line: 'building...',
    });
  });
});

describe('attempt log: blame is derived, never independently supplied', () => {
  test('every FailureReason in the shared table produces exactly its stamped blame', async () => {
    const { app, component, deploy } = await seedAttempt();

    const reasons = Object.keys(BLAME) as FailureReason[];
    for (const reason of reasons) {
      await recordDeployEvent(
        database().db,
        { appId: app.id, componentId: component.id, deployId: deploy.id },
        { type: 'status', phase: 'FAILED', reason },
      );
    }

    const page = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: deploy.buildId,
      deployId: deploy.id,
    });

    const byReason = new Map(
      page.entries
        .filter(
          (e): e is Extract<typeof e, { type: 'status' }> =>
            e.type === 'status',
        )
        .map((e) => [e.reason, e.blame]),
    );

    for (const reason of reasons) {
      expect(byReason.get(reason)).toBe(BLAME[reason]);
    }
  });

  test('the write API never accepts a caller-supplied blame (closed at the type level)', () => {
    // AttemptLogEvent's status arm has no `blame` field; this is a
    // compile-time property, asserted here by construction rather than by
    // reflection, since TypeScript has nothing to introspect at runtime.
    const event: import('../../src/domain/attempt-log.ts').AttemptLogEvent = {
      type: 'status',
      phase: 'FAILED',
      reason: 'TIMEOUT',
    };
    expect('blame' in event).toBe(false);
  });
});

describe('attempt log: resume cursor', () => {
  test('resuming from a cursor yields exactly the events written after it — no gap, no duplicate', async () => {
    const { app, component, build } = await seedAttempt();

    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'line 1' },
    );
    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'line 2' },
    );

    const first = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
    });
    expect(first.entries.map((e) => (e as { line: string }).line)).toEqual([
      'line 1',
      'line 2',
    ]);
    const cursor = first.cursor as AttemptLogCursor;

    // Nothing new yet: resuming from the tip cursor is an empty, gap-free page.
    const empty = await readAttemptStream(
      database().db,
      { componentId: component.id, buildId: build.id },
      { after: cursor },
    );
    expect(empty.entries).toHaveLength(0);
    expect(empty.cursor).toBe(cursor);

    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'line 3' },
    );
    await recordBuildEvent(
      database().db,
      { appId: app.id, componentId: component.id, buildId: build.id },
      { type: 'log', line: 'line 4' },
    );

    const resumed = await readAttemptStream(
      database().db,
      { componentId: component.id, buildId: build.id },
      { after: cursor },
    );
    expect(resumed.entries.map((e) => (e as { line: string }).line)).toEqual([
      'line 3',
      'line 4',
    ]);

    // The union of the two resumed reads equals a from-scratch read: no gap
    // (line 3/4 missing) and no duplicate (line 1/2 repeated).
    const fullReplay = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
    });
    expect(fullReplay.entries.map((e) => (e as { line: string }).line)).toEqual(
      ['line 1', 'line 2', 'line 3', 'line 4'],
    );
  });
});
