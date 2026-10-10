import { describe, expect, test } from 'bun:test';
import { CloseCodes } from '@discordjs/ws';
import { createGateway } from '../src/gateway.ts';
import { Health } from '../src/health.ts';
import type { SessionStore } from '../src/session.ts';
import { FakeClock, RecordingLog } from './support.ts';

describe('leaving the gateway', () => {
  test('seals the store, closes with the resume code and a reason, then flushes', async () => {
    const calls: string[] = [];
    const store: SessionStore = {
      retrieve: async () => null,
      update: async () => {},
      seal: () => {
        calls.push('seal');
      },
      flush: async () => {
        calls.push('flush');
      },
    };
    const gateway = createGateway({
      token: 'x',
      store,
      log: new RecordingLog(),
      health: new Health(),
      clock: new FakeClock(),
      exit: () => {},
    });
    let options: unknown;
    gateway.manager.destroy = (async (given: unknown) => {
      calls.push('destroy');
      options = given;
    }) as never;
    await gateway.leave('mate is shutting down');
    expect(calls).toEqual(['seal', 'destroy', 'flush']);
    expect(options).toEqual({
      code: CloseCodes.Resuming,
      reason: 'mate is shutting down',
    });
  });
});
