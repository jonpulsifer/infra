/**
 * The two things an interval got wrong, asserted against the chain that
 * replaced it.
 *
 * `setInterval` fired whether or not the last read came back, so the
 * workspace's two-second in-flight cadence stacked requests the moment a read
 * took longer than the gap — and it fired in a hidden tab, so a page left open
 * in another window polled the installation all day. Neither is visible from a
 * screen: both are about *when* a read is issued, which is why this drives the
 * hook itself rather than reaching it through a mounted view.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePoll } from '../../src/web/poll.ts';
import { type DomShim, installDomShim } from '../harness/dom.ts';

let shim: DomShim;
let root: Root;
/** Set by a case that wants the document to report itself hidden. */
let visibility: 'visible' | 'hidden' = 'visible';

beforeEach(() => {
  visibility = 'visible';
  shim = installDomShim();
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
