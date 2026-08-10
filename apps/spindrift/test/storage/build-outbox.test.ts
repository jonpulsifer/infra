/**
 * The bosun outbox's claim race, over real Postgres (Task: bosun build
 * route).
 *
 * § Testing: "the concurrency design is a claim about transactions and a
 * fake store cannot falsify it." `claim` is `SELECT ... FOR UPDATE SKIP
 * LOCKED`, the identical mechanism `test/reconciler/deploy-loop.test.ts`
 * proves for `claimNextDeploy` — this file is that proof for the outbox.
 */
import { describe, expect, test } from 'bun:test';
import { createDb } from '../../src/db/client.ts';
import {
  BUILD_REQUEST_LEASE_MS,
  buildOutbox,
} from '../../src/storage/build-outbox.ts';
import { withIsolatedDatabase } from '../harness/db.ts';

const database = withIsolatedDatabase();

describe('enqueue and claim', () => {
  test('a claim returns the request document verbatim', async () => {
    const store = buildOutbox(database().db);
    const request = { source: { bundleDigest: 'sha256:bundle' }, spec: {} };
    const { id } = await store.enqueue({ class: 'skiff-a', request });

    const claimed = await store.claim(['skiff-a']);
    expect(claimed).toEqual({ id, class: 'skiff-a', request });
  });

  test('claim filters by class', async () => {
    const store = buildOutbox(database().db);
    await store.enqueue({ class: 'skiff-a', request: { n: 1 } });
    const { id: wanted } = await store.enqueue({
      class: 'skiff-b',
      request: { n: 2 },
    });

    const claimed = await store.claim(['skiff-b']);
    expect(claimed?.id).toBe(wanted);
    // Nothing left to claim under either class this call could take: the
    // `skiff-a` row is untouched (wrong class) and `skiff-b`'s is taken.
    expect(await store.claim(['skiff-b'])).toBeNull();
  });

  test('claim is oldest-first within a class', async () => {
    const store = buildOutbox(database().db);
    const { id: older } = await store.enqueue({
      class: 'skiff-a',
      request: { n: 1 },
    });
    await store.enqueue({ class: 'skiff-a', request: { n: 2 } });

    expect((await store.claim(['skiff-a']))?.id).toBe(older);
  });

  test('nothing to claim answers null', async () => {
    const store = buildOutbox(database().db);
    expect(await store.claim(['skiff-a'])).toBeNull();
  });

  test('an empty class list claims nothing', async () => {
    const store = buildOutbox(database().db);
    await store.enqueue({ class: 'skiff-a', request: {} });
    expect(await store.claim([])).toBeNull();
  });

  test('a claimed row is not claimed twice', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    expect((await store.claim(['skiff-a']))?.id).toBe(id);
    expect(await store.claim(['skiff-a'])).toBeNull();
  });
});

describe('claiming is race-safe under concurrency (SKIP LOCKED)', () => {
  test('two concurrent claims never return the same row', async () => {
    const store = buildOutbox(database().db);
    const other = buildOutbox(createDb(database().connect()));
    const { id: first } = await store.enqueue({
      class: 'skiff-a',
      request: { n: 1 },
    });
    const { id: second } = await store.enqueue({
      class: 'skiff-a',
      request: { n: 2 },
    });

    const [a, b] = await Promise.all([
      store.claim(['skiff-a']),
      other.claim(['skiff-a']),
    ]);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a?.id).not.toBe(b?.id);
    expect([a?.id, b?.id].sort()).toEqual([first, second].sort());
  });
});

describe('lease expiry and reclamation', () => {
  test('a claimed row is reclaimed once its lease expires, and stays claimed until then', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = buildOutbox(database().db, () => clock);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    expect((await store.claim(['skiff-a']))?.id).toBe(id);

    // Well within the lease: reclamation finds nothing, and the row stays
    // unavailable to a second claimant.
    clock = new Date(clock.getTime() + BUILD_REQUEST_LEASE_MS - 1000);
    await store.reclaimExpired();
    expect(await store.claim(['skiff-a'])).toBeNull();

    // Past the lease: reclamation returns it to PENDING, claimable again.
    clock = new Date(clock.getTime() + 2000);
    await store.reclaimExpired();
    expect((await store.claim(['skiff-a']))?.id).toBe(id);
  });

  test('heartbeat extends the lease', async () => {
    let clock = new Date('2026-01-01T00:00:00.000Z');
    const store = buildOutbox(database().db, () => clock);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    clock = new Date(clock.getTime() + BUILD_REQUEST_LEASE_MS - 1000);
    expect(await store.heartbeat(id)).toBe(true);

    // Had the heartbeat not landed, this moment would already be past the
    // original lease and reclaimable.
    clock = new Date(clock.getTime() + BUILD_REQUEST_LEASE_MS - 1000);
    await store.reclaimExpired();
    expect(await store.claim(['skiff-a'])).toBeNull();
  });

  test('heartbeat on an unclaimed or unknown id answers false', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    // PENDING, never claimed.
    expect(await store.heartbeat(id)).toBe(false);
    expect(await store.heartbeat(crypto.randomUUID())).toBe(false);
  });
});

describe('complete', () => {
  test('the first result lands, done', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    const result = { status: 'SUCCEEDED' as const, log: 'ok' };
    expect(await store.complete(id, result)).toBe('done');
    expect((await store.get(id))?.state).toBe('DONE');
    expect((await store.get(id))?.result).toEqual(result);
  });

  test('a second result conflicts and the first is kept', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);

    const first = { status: 'SUCCEEDED' as const, log: 'ok' };
    expect(await store.complete(id, first)).toBe('done');
    const second = { status: 'FAILED' as const, log: 'late', detail: 'x' };
    expect(await store.complete(id, second)).toBe('conflict');
    expect((await store.get(id))?.result).toEqual(first);
  });

  test('an unknown id is missing', async () => {
    const store = buildOutbox(database().db);
    const result = { status: 'SUCCEEDED' as const, log: 'ok' };
    expect(await store.complete(crypto.randomUUID(), result)).toBe('missing');
  });
});

describe('get and cancel', () => {
  test('get answers null for an unknown id', async () => {
    const store = buildOutbox(database().db);
    expect(await store.get(crypto.randomUUID())).toBeNull();
  });

  test('cancel marks a live row DONE with no result', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.cancel(id);

    const row = await store.get(id);
    expect(row?.state).toBe('DONE');
    expect(row?.result).toBeNull();
    // A cancelled row can never be claimed later.
    expect(await store.claim(['skiff-a'])).toBeNull();
  });

  test('cancel never clobbers a result that already landed', async () => {
    const store = buildOutbox(database().db);
    const { id } = await store.enqueue({ class: 'skiff-a', request: {} });
    await store.claim(['skiff-a']);
    const result = { status: 'SUCCEEDED' as const, log: 'ok' };
    await store.complete(id, result);

    await store.cancel(id);

    expect((await store.get(id))?.result).toEqual(result);
  });
});
