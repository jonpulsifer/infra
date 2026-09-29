export type Handle = object;

export interface Clock {
  now(): number;
  after(ms: number, fn: () => void): Handle;
  cancel(handle: Handle): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after: (ms, fn) => setTimeout(fn, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      function onAbort() {
        clearTimeout(timer);
        reject(signal?.reason);
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
};

/** A time the owner reads: the hour today, the date as well on another day. */
export function utc(ms: number, now: number): string {
  const [day, time] = new Date(ms).toISOString().split('T');
  const today = new Date(now).toISOString().split('T')[0];
  const clock = time?.slice(0, 5) ?? '';
  return day === today ? `${clock} UTC` : `${day} ${clock} UTC`;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}
