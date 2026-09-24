import { describe, expect, test } from 'bun:test';
import {
  isReconnecting,
  markReconnecting,
  markSettled,
  onConnectionChange,
} from '../../src/web/connection-status.ts';

describe('the shared reconnecting flag', () => {
  // The stream client marks a stream again on every drop until it settles.
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
