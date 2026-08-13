/**
 * The one cadence every screen re-reads on, and the one read state they all
 * hold while they do.
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
 * refusal on a tick was dropped. One read means one answer to that, and
 * {@link useRead} states it once — keep what is on screen if it is readable,
 * and only show a refusal to someone who has nothing.
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
import { useCallback, useEffect, useState } from 'react';
import {
  type Call,
  command,
  type OutputsOf,
  type TransportFailure,
} from './client.ts';

/** Whether reading right now would be a request nobody is looking at. */
function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

/**
 * The cadence chain, without the read state {@link useRead} wraps it in.
 *
 * `ms` of `null` is a read that happens once per change of `deps` and is not
 * re-armed — the screens whose far side is a GitHub listing or a manifest, for
 * which a background tick every fifteen seconds is a rate limit spent on an
 * answer nobody asked for again. A null cadence also ignores visibility, since
 * skipping the one read a screen gets would leave it loading forever.
 *
 * Exported for `test/web/poll.test.tsx`, which drives the two properties an
 * interval got wrong directly rather than through a screen: both are about
 * *when* a read is issued, and neither is visible from the rendered output.
 */
export function usePoll(
  read: (signal: AbortSignal) => Promise<unknown>,
  ms: number | null,
  deps: readonly unknown[] = [],
): void {
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let reading = false;

    const arm = () => {
      if (ms === null || controller.signal.aborted || timer !== null) return;
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
      if (ms !== null && hidden()) {
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
      // A null cadence asked for one read per change of `deps`, and a tab
      // coming back is not one of those. Without this, the screens that chose
      // `null` precisely because their far side is rate-limited — the
      // repository, bucket and registry lists — spend a call every time
      // someone alt-tabs back to a page they are not even looking at.
      if (ms === null) return;
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

/**
 * Loading, refused, or read — the three states a screen has data in.
 *
 * A refusal is carried whole rather than as its sentence, because
 * {@link TransportFailure}'s `code` is a closed set and one screen branches on
 * it: an App name that resolves to nothing is `NOT_FOUND`, which is somewhere
 * definite to go rather than a load that failed. A read that *threw* is given
 * `INTERNAL` — `client.ts` draws the line that only a response which was not
 * the server answering throws, and by the time it is on screen that difference
 * has no consequence a reader could act on.
 */
export type ReadState<Value> =
  | { readonly type: 'loading' }
  | { readonly type: 'error'; readonly failure: TransportFailure }
  | { readonly type: 'success'; readonly value: Value };

/**
 * How often to re-read, decided from what was read.
 *
 * A function rather than a number for the two screens that have two cadences —
 * the workspace and the App list both poll fast while a release is in flight
 * and slowly once it settles — and a number cannot express that, because the
 * fact it depends on is the answer this hook has not returned yet. `null` is
 * the value before the first read lands, and for a screen with nothing on it
 * the slow cadence is always right.
 */
export type Cadence<Value> = number | null | ((value: Value | null) => number);

/**
 * What a screen holds while it reads, and the two ways it writes back.
 *
 * `reload` is the retry button *and* the re-read after an act — the same token
 * every screen grew by hand, and one thing rather than two because they are the
 * same request. `update` is for the answer a screen already has and the server
 * has not been asked for: a row deleted from a list it is showing, a log line
 * that arrived over the socket. It is a no-op unless there is a value to
 * update, which is what removes the `current.type === 'success'` guard every
 * caller used to open with.
 */
export type Read<Value> = ReadState<Value> & {
  /** Whether a read is outstanding — the refresh control's spinner. */
  readonly pending: boolean;
  reload(): void;
  update(next: (value: Value) => Value): void;
};

/**
 * Read one or more commands on a cadence, as one answer.
 *
 * Every screen wrote this out: a three-armed `useState`, a `Promise.all`, an
 * `ok` check per result, a `signal.aborted` guard, a catch that turned a thrown
 * cause into a sentence, and a token to re-run the lot. Thirty copies of it,
 * and they had drifted in exactly the places a copy drifts — which refusal is
 * reported when two reads refuse, whether a lost request blanks a screen that
 * was readable a second ago.
 *
 * The answers this gives once, for all of them:
 *
 * - **The first refusal wins.** A screen showing one sentence should show the
 *   reason it could not be drawn, and the earliest read to refuse is the one
 *   nearest the reason.
 * - **A refusal replaces the screen; a throw does not.** A refusal is an answer
 *   the server gave — an App deleted from another window stops being shown as
 *   though it were still there. A throw is a gap, and a screen with something
 *   readable on it keeps it and lets the next tick close the gap, because
 *   replacing a live view with an error page over one lost request takes away
 *   more than it explains.
 * - **A response that arrives after the chain was torn down is dropped**, which
 *   is `usePoll`'s signal, checked here so no caller has to remember to.
 *
 * `merge` is for the three screens whose fresh read is not the whole truth: two
 * ledgers hold pages the reader paged in, and the workspace holds log lines the
 * socket delivered and this read cannot know about. It is called with the fresh
 * answer and the one on screen, and it is captured with the chain — it must not
 * close over state that changes between reads, or it will merge into a value
 * that has moved on.
 */
export function useRead<const Calls extends readonly Call[]>(
  calls: Calls,
  cadence: Cadence<OutputsOf<Calls>>,
  deps: readonly unknown[] = [],
  merge?: (
    fresh: OutputsOf<Calls>,
    current: OutputsOf<Calls>,
  ) => OutputsOf<Calls>,
): Read<OutputsOf<Calls>> {
  const [state, setState] = useState<ReadState<OutputsOf<Calls>>>({
    type: 'loading',
  });
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState(0);

  const ms =
    typeof cadence === 'function'
      ? cadence(state.type === 'success' ? state.value : null)
      : cadence;

  usePoll(
    async (signal) => {
      setPending(true);
      try {
        const results = await Promise.all(
          // The pairing is checked at the call site by `Call`; recovering it
          // per element from a heterogeneous list is not something a mapped
          // type can do for `command`'s two correlated parameters, so the
          // one cast in this module lives here.
          calls.map(([name, input]) => command(name, input as never)),
        );
        if (signal.aborted) return;
        const refused = results.find((result) => !result.ok);
        if (refused !== undefined && !refused.ok) {
          setState({ type: 'error', failure: refused.failure });
          return;
        }
        // Every result is `ok` by here — the refusal above returned — but a
        // union does not narrow through the `find` that proved it.
        const fresh = results.map((result) =>
          result.ok ? result.value : null,
        ) as OutputsOf<Calls>;
        setState((current) => ({
          type: 'success',
          value:
            current.type === 'success' && merge !== undefined
              ? merge(fresh, current.value)
              : fresh,
        }));
      } catch (cause: unknown) {
        if (signal.aborted) return;
        setState((current) =>
          current.type === 'success'
            ? current
            : {
                type: 'error',
                failure: {
                  code: 'INTERNAL',
                  message:
                    cause instanceof Error ? cause.message : 'Server failure',
                },
              },
        );
      } finally {
        if (!signal.aborted) setPending(false);
      }
    },
    ms,
    [...deps, token],
  );

  const reload = useCallback(() => setToken((value) => value + 1), []);
  const update = useCallback(
    (next: (value: OutputsOf<Calls>) => OutputsOf<Calls>) =>
      setState((current) => {
        if (current.type !== 'success') return current;
        const value = next(current.value);
        // Returning what it was handed is how a caller says "this frame changes
        // nothing" — a socket page for a Component the screen has moved off, an
        // empty batch — and it has to cost no render, because the pane those
        // arrive at is the largest tree on the screen.
        return value === current.value ? current : { type: 'success', value };
      }),
    [],
  );

  return { ...state, pending, reload, update };
}
