// Drives `usePoll` and `useRead` directly: when a read is issued is not
// visible from a mounted screen.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type Read, usePoll, useRead } from '../../src/web/poll.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

let shim: DomShim;
let root: Root;
let visibility: 'visible' | 'hidden' = 'visible';
// A refusal envelope is the server answering; a throw is `client.ts`'s case for
// a response that did not come from the server.
let answers: Record<string, () => unknown> = {};

beforeEach(() => {
  visibility = 'visible';
  answers = {};
  shim = installDomShim({
    fetch: async (url: string) => {
      const name = url.slice(url.lastIndexOf('/') + 1);
      const answer = answers[name];
      if (answer === undefined) throw new Error(`nothing answers ${name}`);
      const body = answer();
      return { json: async () => body };
    },
  });
  Object.defineProperty(shim.document, 'visibilityState', {
    configurable: true,
    get: () => visibility,
  });
  root = createRoot(shim.document.createElement('div') as never);
});

afterEach(() => {
  act(() => root.unmount());
  shim.restore();
});

function Poller({
  read,
  ms,
}: {
  read: () => Promise<unknown>;
  ms: number | null;
}) {
  usePoll(read, ms);
  return null;
}

describe('a read on a cadence', () => {
  test('never has two outstanding at once', async () => {
    let started = 0;
    let release: (() => void) | null = null;
    const read = () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };

    act(() => root.render(<Poller read={read} ms={1} />));
    expect(started).toBe(1);

    // Several intervals pass with the first read still in flight.
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBe(1);

    await act(async () => {
      release?.();
      await Bun.sleep(20);
    });
    expect(started).toBeGreaterThan(1);
  });

  test('does not read a tab nobody is looking at, and reads it on return', async () => {
    let started = 0;
    const read = () => {
      started += 1;
      return Promise.resolve();
    };

    visibility = 'hidden';
    act(() => root.render(<Poller read={read} ms={1} />));
    await act(async () => {
      await Bun.sleep(20);
    });
    // The timer re-arms; only the request is skipped.
    expect(started).toBe(0);

    visibility = 'visible';
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBeGreaterThan(0);
  });

  test('a null cadence does not spend a read on a tab coming back', async () => {
    let started = 0;
    const read = () => {
      started += 1;
      return Promise.resolve();
    };

    act(() => root.render(<Poller read={read} ms={null} />));
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBe(1);

    // `null` reads once per change of `deps`. The screens that use it sit in
    // front of a rate limit.
    await act(async () => {
      shim.document.dispatch('visibilitychange');
      await Bun.sleep(20);
    });
    expect(started).toBe(1);
  });

  test('a read that throws does not end the chain', async () => {
    let started = 0;
    const read = () => {
      started += 1;
      return Promise.reject(new Error('the link went away'));
    };

    act(() => root.render(<Poller read={read} ms={1} />));
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBeGreaterThan(2);
  });

  test('stops on unmount', async () => {
    let started = 0;
    const read = () => {
      started += 1;
      return Promise.resolve();
    };

    act(() => root.render(<Poller read={read} ms={1} />));
    await act(async () => {
      await Bun.sleep(10);
    });
    act(() => root.render(null));
    const settled = started;
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBe(settled);
  });
});

function Reader<Value>({
  read,
  seen,
}: {
  read: () => Read<Value>;
  seen: (state: Read<Value>) => void;
}) {
  seen(read());
  return null;
}

describe('a read of one or more commands', () => {
  test('answers with one value per command, in the order they were asked', async () => {
    answers.listApps = () => ({ ok: true, value: { apps: ['one'] } });
    answers.listTargets = () => ({ ok: true, value: { targets: ['two'] } });
    let state: Read<unknown> | null = null;

    await act(async () => {
      root.render(
        <Reader
          read={() =>
            useRead(
              [
                ['listApps', {}],
                ['listTargets', {}],
              ],
              null,
            )
          }
          seen={(next) => {
            state = next;
          }}
        />,
      );
      await Bun.sleep(10);
    });

    expect(state).toMatchObject({
      type: 'success',
      value: [{ apps: ['one'] }, { targets: ['two'] }],
    });
  });

  test('reports the first refusal, not the last', async () => {
    answers.listApps = () => ({
      ok: false,
      failure: { code: 'FORBIDDEN', message: 'the Apps read was refused' },
    });
    answers.listTargets = () => ({
      ok: false,
      failure: { code: 'NOT_FOUND', message: 'the Targets read was refused' },
    });
    let state: Read<unknown> | null = null;

    await act(async () => {
      root.render(
        <Reader
          read={() =>
            useRead(
              [
                ['listApps', {}],
                ['listTargets', {}],
              ],
              null,
            )
          }
          seen={(next) => {
            state = next;
          }}
        />,
      );
      await Bun.sleep(10);
    });

    expect(state).toMatchObject({
      type: 'error',
      failure: { message: 'the Apps read was refused' },
    });
  });

  test('a lost read keeps what is readable; a refusal replaces it', async () => {
    answers.listApps = () => ({ ok: true, value: { apps: ['one'] } });
    let state: Read<unknown> | null = null;

    await act(async () => {
      root.render(
        <Reader
          read={() => useRead([['listApps', {}]], null)}
          seen={(next) => {
            state = next;
          }}
        />,
      );
      await Bun.sleep(10);
    });
    expect(state).toMatchObject({ type: 'success' });

    // A throw is not the server answering, so the screen keeps its value.
    answers.listApps = () => {
      throw new Error('the link went away');
    };
    await act(async () => {
      state?.reload();
      await Bun.sleep(10);
    });
    expect(state).toMatchObject({
      type: 'success',
      value: [{ apps: ['one'] }],
    });

    // A refusal is the server answering, so it replaces the value.
    answers.listApps = () => ({
      ok: false,
      failure: { code: 'NOT_FOUND', message: 'no App by that name' },
    });
    await act(async () => {
      state?.reload();
      await Bun.sleep(10);
    });
    expect(state).toMatchObject({
      type: 'error',
      failure: { message: 'no App by that name' },
    });
  });

  test('merges the fresh answer into the one on screen', async () => {
    let served = 0;
    answers.listApps = () => {
      served += 1;
      return { ok: true, value: { apps: [`read ${served}`] } };
    };
    let state: Read<unknown> | null = null;

    await act(async () => {
      root.render(
        <Reader
          read={() =>
            useRead([['listApps', {}]], null, [], ([fresh], [current]) => [
              { apps: [...current.apps, ...fresh.apps] },
            ])
          }
          seen={(next) => {
            state = next;
          }}
        />,
      );
      await Bun.sleep(10);
    });
    // The first read has nothing to merge with.
    expect(state).toMatchObject({
      type: 'success',
      value: [{ apps: ['read 1'] }],
    });

    await act(async () => {
      state?.reload();
      await Bun.sleep(10);
    });
    expect(state).toMatchObject({
      type: 'success',
      value: [{ apps: ['read 1', 'read 2'] }],
    });
  });
});
