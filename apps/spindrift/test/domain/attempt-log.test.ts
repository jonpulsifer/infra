import { describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import {
  BLAME,
  type FailureReason,
} from '../../src/adapters/deploy/contract.ts';
import { createDb } from '../../src/db/client.ts';
import {
  apps,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import {
  type AttemptLogCursor,
  type AttemptLogEntry,
  type AttemptStreamRef,
  MAX_ATTEMPT_LOG_LINES,
  readAttemptStream,
  recordBuildEvent,
  recordDeployEvent,
} from '../../src/domain/attempt-log.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { targetValues } from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();

async function seedAttempt() {
  const [app] = await database()
    .db.insert(apps)
    .values({ name: `app-${crypto.randomUUID()}`, sourceKind: 'repo' })
    .returning();
  const [target] = await database()
    .db.insert(targets)
    .values(targetValues())
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
      targetShape: 'image',
      artifactType: 'image',
    })
    .returning();
  const [deploy] = await database()
    .db.insert(deploys)
    .values({
      componentId: component!.id,
      desired: aDesiredDocument(),
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
    // The status arm has no blame field, so adding one here fails to compile.
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

    const fullReplay = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
    });
    expect(fullReplay.entries.map((e) => (e as { line: string }).line)).toEqual(
      ['line 1', 'line 2', 'line 3', 'line 4'],
    );
  });
});

describe('attempt log: line ceiling', () => {
  const MARKER = `output truncated after ${MAX_ATTEMPT_LOG_LINES} lines; the runner keeps the rest`;

  /** Pages through the stream, since one read returns at most 500 entries. */
  async function everything(ref: AttemptStreamRef): Promise<AttemptLogEntry[]> {
    const entries: AttemptLogEntry[] = [];
    let after: AttemptLogCursor | undefined;
    for (;;) {
      const page = await readAttemptStream(
        database().db,
        ref,
        after === undefined ? {} : { after },
      );
      if (page.entries.length === 0) return entries;
      entries.push(...page.entries);
      after = page.cursor as AttemptLogCursor;
    }
  }

  async function fillToCeiling(
    scope: { appId: string; componentId: string },
    leg: { buildId: number } | { deployId: number },
  ) {
    const buildId = 'buildId' in leg ? leg.buildId : null;
    const deployId = 'deployId' in leg ? leg.deployId : null;
    await database().db.execute(sql`
      insert into attempt_events
        (app_id, component_id, attempt_kind, build_id, deploy_id, event_type, line)
      select ${scope.appId}::uuid, ${scope.componentId}::uuid,
        ${buildId === null ? 'deploy' : 'build'}::attempt_kind,
        ${buildId}::bigint, ${deployId}::bigint, 'log', 'line ' || g
      from generate_series(1, ${MAX_ATTEMPT_LOG_LINES}) as g
    `);
  }

  test('the line past the ceiling becomes one marker naming the run; later lines are dropped; a status still lands', async () => {
    const { app, component, build } = await seedAttempt();
    const scope = { appId: app.id, componentId: component.id };
    const attempt = { ...scope, buildId: build.id };
    // Set first: the marker reads runUrl when it is written.
    const runUrl = 'https://github.com/example/app/actions/runs/1234';
    await database()
      .db.update(builds)
      .set({ runUrl })
      .where(eq(builds.id, build.id));
    await fillToCeiling(scope, { buildId: build.id });

    await recordBuildEvent(database().db, attempt, {
      type: 'log',
      line: 'one past the ceiling',
      resource: 'build',
    });
    await recordBuildEvent(database().db, attempt, {
      type: 'log',
      line: 'two past the ceiling',
    });
    // A new connection has no cached count, so it counts the table and drops
    // the line instead of writing a second marker.
    const resurrected = createDb(database().connect());
    await recordBuildEvent(resurrected, attempt, {
      type: 'log',
      line: 'three past the ceiling, from a fresh process',
    });
    await recordBuildEvent(database().db, attempt, {
      type: 'status',
      phase: 'FAILED',
      reason: 'BUILD_FAILED',
    });

    const entries = await everything({
      componentId: component.id,
      buildId: build.id,
    });
    // The ceiling's lines, the marker and the verdict.
    expect(entries).toHaveLength(MAX_ATTEMPT_LOG_LINES + 2);
    const lines = entries.filter((entry) => entry.type === 'log');
    expect(lines).toHaveLength(MAX_ATTEMPT_LOG_LINES + 1);
    expect(lines.at(-1)).toMatchObject({
      line: `${MARKER} at ${runUrl}`,
      resource: null,
    });
    expect(lines.filter((entry) => entry.line.startsWith(MARKER))).toHaveLength(
      1,
    );
    expect(entries.at(-1)).toMatchObject({
      type: 'status',
      phase: 'FAILED',
      reason: 'BUILD_FAILED',
    });
  });

  test('a deploy leg is capped the same way, through the same writer', async () => {
    const { app, component, build, deploy } = await seedAttempt();
    const scope = { appId: app.id, componentId: component.id };
    const attempt = { ...scope, deployId: deploy.id };
    await fillToCeiling(scope, { deployId: deploy.id });

    await recordDeployEvent(database().db, attempt, {
      type: 'log',
      line: 'one past the ceiling',
    });
    await recordDeployEvent(database().db, attempt, {
      type: 'log',
      line: 'two past the ceiling',
    });
    await recordDeployEvent(database().db, attempt, {
      type: 'status',
      phase: 'LIVE',
    });

    const entries = await everything({
      componentId: component.id,
      buildId: build.id,
      deployId: deploy.id,
    });
    expect(entries).toHaveLength(MAX_ATTEMPT_LOG_LINES + 2);
    expect(entries.at(-2)).toMatchObject({
      attemptKind: 'deploy',
      type: 'log',
      line: MARKER,
    });
    expect(entries.at(-1)).toMatchObject({ type: 'status', phase: 'LIVE' });
  });

  test('under the ceiling every line is kept, counted from where the table already was', async () => {
    const { app, component, build } = await seedAttempt();
    const attempt = {
      appId: app.id,
      componentId: component.id,
      buildId: build.id,
    };
    // Raw SQL, so this process has no cached count for the attempt.
    await database().db.execute(sql`
      insert into attempt_events (app_id, component_id, attempt_kind, build_id, event_type, line)
      values (${app.id}::uuid, ${component.id}::uuid, 'build', ${build.id}, 'log', 'already there')
    `);
    await recordBuildEvent(database().db, attempt, {
      type: 'log',
      line: 'and one more',
    });

    const page = await readAttemptStream(database().db, {
      componentId: component.id,
      buildId: build.id,
    });
    expect(
      page.entries.map((entry) => (entry as { line: string }).line),
    ).toEqual(['already there', 'and one more']);
  });
});
