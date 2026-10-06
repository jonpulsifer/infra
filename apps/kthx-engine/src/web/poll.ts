/**
 * The cadence screens re-read on. Each read is scheduled from the end of the
 * last, so one is outstanding at a time, and a hidden tab skips its ticks.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  type Call,
  command,
  type OutputsOf,
  type TransportFailure,
} from './client.ts';

function hidden(): boolean {
  return document.visibilityState === 'hidden';
}

/**
 * `ms` of `null` reads once per change of `deps` and ignores visibility, for
 * screens backed by rate-limited listings. `deps` works as in `useEffect`.
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
      if (ms !== null && hidden()) {
        arm();
        return;
      }
      reading = true;
      // The caller reports its own failures, and the chain continues past one.
      void read(controller.signal)
        .catch(() => {})
        .finally(() => {
          reading = false;
          arm();
        });
    };

    const onVisibility = () => {
      // A null cadence reads once per `deps` change, so returning to the tab
      // spends no call.
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

export type ReadState<Value> =
  | { readonly type: 'loading' }
  | { readonly type: 'error'; readonly failure: TransportFailure }
  | { readonly type: 'success'; readonly value: Value };

/**
 * `null` reads once. A function picks the delay from the last value read, and
 * is handed `null` until one arrives.
 */
export type Cadence<Value> = number | null | ((value: Value | null) => number);

/**
 * `update` changes the value on screen without a request, and does nothing
 * unless the last read succeeded.
 */
export type Read<Value> = ReadState<Value> & {
  readonly pending: boolean;
  reload(): void;
  update(next: (value: Value) => Value): void;
};

/**
 * Reads commands on a cadence as one answer. The first refusal replaces the
 * screen; a thrown read shows only when nothing readable is on screen yet.
 */
export function useRead<const Calls extends readonly Call[]>(
  calls: Calls,
  cadence: Cadence<OutputsOf<Calls>>,
  deps: readonly unknown[] = [],
  // Captured when the chain starts, so it must not close over state that
  // changes between reads.
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
          // `Call` checks each pairing at the call site. No mapped type can
          // recover it per element for `command`'s correlated parameters.
          calls.map(([name, input]) => command(name, input as never)),
        );
        if (signal.aborted) return;
        const refused = results.find((result) => !result.ok);
        if (refused !== undefined && !refused.ok) {
          setState({ type: 'error', failure: refused.failure });
          return;
        }
        // All `ok` by here, but a union does not narrow through `find`.
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
        // Returning the value it was handed means nothing changed, and costs no
        // render.
        return value === current.value ? current : { type: 'success', value };
      }),
    [],
  );

  return { ...state, pending, reload, update };
}
