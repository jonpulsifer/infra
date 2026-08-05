/**
 * The shared "any stream is retrying" flag `shell.tsx` reads to show a
 * disconnected banner. The one claim worth a test on its own: membership is
 * idempotent, so a socket that drops twice before its next message — the
 * ordinary shape of `stream-client.ts`'s backoff — never leaves the flag
 * stuck on for one stream while another has long since settled.
 */
import { describe, expect, test } from 'bun:test';
import {
  isReconnecting,
  markReconnecting,
  markSettled,
  onConnectionChange,
} from '../../src/web/connection-status.ts';

describe('the shared reconnecting flag', () => {
  test('marking the same id twice does not require two settles to clear', () => {
    const id = Symbol('a');
    markReconnecting(id);
    markReconnecting(id);
    expect(isReconnecting()).toBe(true);
    markSettled(id);
    expect(isReconnecting()).toBe(false);
  });

  test('stays true while any one of several streams is still retrying', () => {
    const a = Symbol('a');
    const b = Symbol('b');
    markReconnecting(a);
    markReconnecting(b);
    markSettled(a);
    expect(isReconnecting()).toBe(true);
    markSettled(b);
    expect(isReconnecting()).toBe(false);
  });

  test('listeners hear only real changes, not repeats', () => {
    const id = Symbol('a');
    let notifications = 0;
    const unsubscribe = onConnectionChange(() => {
      notifications += 1;
    });
    markReconnecting(id);
    markReconnecting(id);
    markSettled(id);
    markSettled(id);
    unsubscribe();
    expect(notifications).toBe(2);
  });
});
