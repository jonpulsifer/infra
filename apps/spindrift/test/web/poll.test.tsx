/**
 * The two things an interval got wrong, and the four answers every screen used
 * to write out by hand — asserted against the chain and the read that replaced
 * them.
 *
 * `setInterval` fired whether or not the last read came back, so the
 * workspace's two-second in-flight cadence stacked requests the moment a read
 * took longer than the gap — and it fired in a hidden tab, so a page left open
 * in another window polled the installation all day. Neither is visible from a
 * screen: both are about *when* a read is issued, which is why this drives the
 * hook itself rather than reaching it through a mounted view.
 *
 * The same goes for what `useRead` decides. Which refusal a screen reporting
 * one shows, and whether a lost request blanks a screen that was readable a
 * second ago, are claims about the hook: thirty screens used to answer them
 * thirty times, and the drift between those copies is what this replaces.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { type Read, usePoll, useRead } from '../../src/web/poll.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

let shim: DomShim;
let root: Root;
/** Set by a case that wants the document to report itself hidden. */
let visibility: 'visible' | 'hidden' = 'visible';
/**
 * How the command dispatch answers, per command name and per case.
 *
 * `client.ts` reaches the network through the one `fetch` global and nothing
 * else, so this is the whole seam: a body that is a refusal envelope is the
 * server answering, and a throw is the case `client.ts` reserves for a response
 * that was not the server at all.
 */
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

function Poller({ read, ms }: { read: () => Promise<unknown>; ms: number }) {
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

    // Well past several intervals, with the first read still in flight. An
    // interval would have issued one per tick and queued them behind this.
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
    // The cadence kept its place — it is the request that is skipped, not the
    // timer — so nothing was asked of the server for a screen nobody sees.
    expect(started).toBe(0);

    visibility = 'visible';
    await act(async () => {
      await Bun.sleep(20);
    });
    expect(started).toBeGreaterThan(0);
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
    // A screen that stops refreshing after one bad response is the failure the
    // cadence exists to prevent.
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

/** The last state the hook rendered with, for a case to assert over. */
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

    // A dropped connection or a proxy serving HTML — not the server answering,
    // and not a reason to take a live screen away over one bad tick.
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

    // An answer the server gave — the App was deleted from another window, and
    // continuing to show it as though it were there is the bug.
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
    // Nothing to merge with on the first read, which is why the ledgers can
    // take the fresh cursor on it and keep their own on every one after.
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
