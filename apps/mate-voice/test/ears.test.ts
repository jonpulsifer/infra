import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { Ears, type Receiver } from '../src/ears.ts';
import { silentLog } from '../src/log.ts';

const OWNER = '222222222222222222';

function receiver() {
  const streams: PassThrough[] = [];
  const asked: string[] = [];
  const fake: Receiver = {
    subscribe: (userId) => {
      asked.push(userId);
      const stream = new PassThrough();
      streams.push(stream);
      return stream;
    },
  };
  return { fake, streams, asked };
}

describe('ears', () => {
  test('subscribe to the owner alone and count frames', async () => {
    const { fake, streams, asked } = receiver();
    const heard: number[] = [];
    const ears = new Ears({
      receiver: fake,
      ownerId: OWNER,
      log: silentLog,
      resubscribeCap: 1,
      onFrame: (opus) => heard.push(opus.length),
      onStall: () => {},
    });
    ears.start();
    ears.start();
    expect(asked).toEqual([OWNER]);
    streams[0]?.write(Buffer.alloc(3));
    streams[0]?.write(Buffer.alloc(5));
    await Bun.sleep(5);
    expect(ears.frames).toBe(2);
    expect(heard).toEqual([3, 5]);
    ears.stop();
    expect(streams[0]?.destroyed).toBe(true);
  });

  test('rebuild a stream the library ends, up to the cap, then stall', async () => {
    const { fake, streams, asked } = receiver();
    let stalled = 0;
    const ears = new Ears({
      receiver: fake,
      ownerId: OWNER,
      log: silentLog,
      resubscribeCap: 2,
      onFrame: () => {},
      onStall: () => stalled++,
    });
    ears.start();
    streams[0]?.destroy(new Error('decrypt'));
    await Bun.sleep(5);
    expect(asked.length).toBe(2);
    expect(ears.resubscribes).toBe(1);
    streams[1]?.destroy();
    await Bun.sleep(5);
    expect(asked.length).toBe(3);
    streams[2]?.destroy();
    await Bun.sleep(5);
    expect(asked.length).toBe(3);
    expect(stalled).toBe(1);
  });

  test('a stop is not a stall', async () => {
    const { fake, streams, asked } = receiver();
    let stalled = 0;
    const ears = new Ears({
      receiver: fake,
      ownerId: OWNER,
      log: silentLog,
      resubscribeCap: 0,
      onFrame: () => {},
      onStall: () => stalled++,
    });
    ears.start();
    ears.stop();
    await Bun.sleep(5);
    expect(streams[0]?.destroyed).toBe(true);
    expect(asked.length).toBe(1);
    expect(stalled).toBe(0);
  });
});
