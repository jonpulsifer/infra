/**
 * `expectedDuration` on the deploy screen: a history sentence, never a guess.
 *
 * The estimate is read from the attempt log at read time, so what these tests
 * pin is which rows get to vote — releases of this Component@Target that
 * reached LIVE before this one, and nothing else — and that the answer is
 * withheld under three samples rather than computed anyway.
 */
import { describe, expect, test } from 'bun:test';
import { getDeployDetail } from '../../src/commands/deploys/get-detail.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandContext,
} from '../../src/commands/types.ts';
import {
  apps,
  attemptEvents,
  builds,
  components,
  deploys,
  targets,
} from '../../src/db/schema.ts';
import { withIsolatedDatabase } from '../harness/db.ts';
import { SupplyChainHarness } from '../harness/fakes/supply-chain.ts';
import {
  fixtureManifest,
  insertVessel,
  targetValues,
} from '../harness/installation.ts';
import { aDesiredDocument } from '../harness/release.ts';

const database = withIsolatedDatabase();
const manifest = await fixtureManifest();

const FROZEN = new Date('2026-08-23T12:00:00.000Z');
const clock: Clock = { now: () => FROZEN };

const noAdapters: AdapterRegistry = {
  deploy: () => null,
  build: () => null,
  store: () => null,
  repository: () => null,
  supplyChain: () => new SupplyChainHarness(),
};

function context(): CommandContext {
  return {
    principal: { id: crypto.randomUUID(), displayName: 'Operator' },
    clock,
    db: database().db,
    adapters: noAdapters,
    manifest,
  };
}

/** An App, a Component, one Build, and two connected Targets. */
async function scaffold() {
  const db = database().db;
  const [app] = await db
    .insert(apps)
    .values({ name: 'shop', sourceKind: 'archive' })
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
  // A Target is unique per vessel and adapter, so "elsewhere" is a second
  // cluster.
  const other = await insertVessel(db, 'kubernetes', { name: 'other' });
  const [elsewhere] = await db
    .insert(targets)
    .values(targetValues({ vesselId: other.id }))
    .returning();
  const [build] = await db
    .insert(builds)
    .values({
      componentId: component!.id,
      commit: 'abc123',
      targetShape: 'image',
      artifactType: 'image',
      status: 'SUCCEEDED',
    })
    .returning();
  return {
    app: app!,
    component: component!,
    target: target!,
    elsewhere: elsewhere!,
    build: build!,
  };
}

type Scaffold = Awaited<ReturnType<typeof scaffold>>;

/**
 * One Deploy written at `startedAt`, and — unless it never got there — the
 * LIVE status event the deploy loop records `seconds` later.
 */
async function release(
  seeded: Scaffold,
  options: {
    readonly startedAt: Date;
    readonly seconds?: number;
    readonly targetId?: string;
    readonly phase?: 'LIVE' | 'FAILED' | 'APPLYING';
  },
) {
  const db = database().db;
  const [deploy] = await db
    .insert(deploys)
    .values({
      componentId: seeded.component.id,
      targetId: options.targetId ?? seeded.target.id,
      buildId: seeded.build.id,
      desired: aDesiredDocument(),
      phase: options.phase ?? 'LIVE',
      createdAt: options.startedAt,
    })
    .returning();
  if (options.seconds !== undefined) {
    await db.insert(attemptEvents).values({
      appId: seeded.app.id,
      componentId: seeded.component.id,
      attemptKind: 'deploy',
      deployId: deploy!.id,
      eventType: 'status',
      phase: 'LIVE',
      createdAt: new Date(options.startedAt.getTime() + options.seconds * 1000),
    });
  }
  return deploy!;
}

const at = (minute: number) =>
  new Date(FROZEN.getTime() - (60 - minute) * 60_000);

describe('expected duration', () => {
  test('is withheld under three prior releases', async () => {
    const seeded = await scaffold();
    await release(seeded, { startedAt: at(1), seconds: 60 });
    await release(seeded, { startedAt: at(2), seconds: 90 });
    const running = await release(seeded, {
      startedAt: at(3),
      phase: 'APPLYING',
    });

    const result = await getDeployDetail({ id: running.id }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deploy.expectedDuration).toBeUndefined();
  });

  test('is the p90 of what reached LIVE here before this one, and nothing else', async () => {
    const seeded = await scaffold();
    // The four that vote: 60s, 120s, 180s, 300s — the p90 by nearest rank is
    // the fourth of four.
    await release(seeded, { startedAt: at(1), seconds: 60 });
    await release(seeded, { startedAt: at(2), seconds: 120 });
    await release(seeded, { startedAt: at(3), seconds: 180 });
    await release(seeded, { startedAt: at(4), seconds: 300 });
    // Never reached LIVE: no event, no vote.
    await release(seeded, { startedAt: at(5), phase: 'FAILED' });
    // Reached LIVE somewhere else: not this Component@Target's history.
    await release(seeded, {
      startedAt: at(6),
      seconds: 9_000,
      targetId: seeded.elsewhere.id,
    });
    // The subject, read back after it went LIVE: its own event is not evidence
    // about itself.
    const subject = await release(seeded, { startedAt: at(7), seconds: 9_000 });
    // Newer than the subject: what came after is not what came before.
    await release(seeded, { startedAt: at(8), seconds: 9_000 });

    const result = await getDeployDetail({ id: subject.id }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.deploy.expectedDuration).toEqual({
      p90Ms: 300_000,
      samples: 4,
    });
  });
});
