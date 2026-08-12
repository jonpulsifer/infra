/**
 * The one cadence every screen re-reads on.
 *
 * Four screens each had their own `setInterval` around a `command()` call, and
 * an interval is the wrong primitive for a network read twice over. It fires
 * whether or not the last read came back, so the workspace's two-second
 * in-flight cadence stacked requests behind each other the moment a read took
 * longer than the gap — and the pile never drains, because every tick adds to
 * it. And it keeps firing in a hidden tab, so an App page left open in a window
 * nobody is looking at polls the installation every two seconds all day.
 *
 * A chain fixes both: the next read is scheduled from the end of the last one,
 * so exactly one is ever outstanding, and a tick that comes due while the
 * document is hidden re-arms without reading. Becoming visible reads at once
 * rather than waiting out the remaining delay — the first thing someone
 * returning to a tab wants is what it says now.
 *
 * The first read is immediate, which is what let each of those screens drop the
 * separate mount effect that used to sit beside its interval. That pair was two
 * reads of the same thing written twice, and they had drifted: on three of the
 * four, a refusal on the mount read replaced the screen and the identical
 * refusal on a tick was dropped. One read means one answer to that, and the
 * callers state it once — keep what is on screen if it is readable, and only
 * show a refusal to someone who has nothing.
 *
 * `deps` is the caller's own, and it means what it means in `useEffect`: the
 * chain is torn down and read again from the start when they change.
 *
 * `read` is handed the chain's `AbortSignal` rather than a bespoke `live`
 * boolean. Nothing here cancels the request — `command()` does not take one —
 * but `signal.aborted` is the check a caller needs before it writes, and it is
 * load-bearing for the workspace, whose read is about the selected Component: a
 * response still in flight when the selection moves belongs to a Component the
 * screen has left, and writing it would put that Component back on screen until
 * the next tick.
 */
import { useEffect } from 'react';

/** Whether reading right now would be a request nobody is looking at. */
function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

export function usePoll(
  read: (signal: AbortSignal) => Promise<unknown>,
  ms: number,
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;

    const arm = () => {
      if (controller.signal.aborted || timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        tick();
      }, ms);
    };

    const tick = () => {
      if (controller.signal.aborted || reading) return;
      // Re-armed rather than dropped: the cadence keeps its place, so a tab
      // shown again mid-interval is at most one delay from current, and this
      // costs a timer instead of a request.
      if (hidden()) {
        arm();
        return;
      }
      reading = true;
      // A failed read is the caller's to report or ignore — each of them
      // decides — and the chain continues either way, because a screen that
      // stops refreshing after one bad response is the failure the cadence
      // exists to prevent.
      void read(controller.signal)
        .catch(() => {})
        .finally(() => {
          reading = false;
          arm();
        });
    };

    const onVisibility = () => {
      if (hidden()) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      tick();
    };

    tick();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      controller.abort();
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ms, ...deps]);
}
