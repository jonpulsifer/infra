/**
 * `fetch` with a deadline, for every call this CLI makes over the network.
 *
 * Bun's `fetch` dials the first address the resolver answers with and has no
 * happy-eyeballs fallback. On a host whose IPv6 route to the site goes dark —
 * no RST, just silence — the connect sits on the OS timeout, minutes past
 * anyone's patience, and a `kthx dev` loop or a `kthx deploy` looks hung with
 * nothing printed. `dns.setDefaultResultOrder('ipv4first')` is not the lever:
 * measured on Bun 1.4.0, `node:dns.lookup` reorders and `Bun.dns.lookup` — the
 * resolver `fetch` goes through — does not. So the bound is the fix, and it is
 * the whole fix: a bounded call fails out loud.
 *
 * The clock runs until the answer's headers arrive, not until the body ends. A
 * proxied download is as long as it is; what must never happen is waiting on a
 * site that is not going to speak.
 */
import { KthxError } from './error.ts';

/** How long a call that only asks for something gets to answer. */
export const REACH_MS = 15_000;

/**
 * How long a call that sends bytes up gets instead.
 *
 * A site cannot answer an upload or a model call until it has the whole
 * request, so the read bound would refuse work that is going fine — and 120 s
 * is what `kthx dev` already gives the tab's own socket.
 */
export const SEND_MS = 120_000;

/** `15s`, `0.3s` — a deadline said the way an error message says it. */
export const seconds = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/** Whether a rejected call ran out of time rather than failing to connect. */
export const timedOut = (error: unknown): boolean =>
  (error as { name?: string } | null)?.name === 'TimeoutError';

/**
 * The failure a bounded call becomes, as the CLI prints it.
 *
 * A deadline and a refused connection are different news — "the site is not
 * answering" against "there is nothing there" — and the message says which.
 */
export const unreachable = (
  where: string,
  cause: unknown,
  ms = REACH_MS,
): KthxError =>
  new KthxError(
    'UNREACHABLE',
    timedOut(cause)
      ? `${where} did not answer in ${seconds(ms)}`
      : `${where}: ${(cause as Error).message}`,
  );

/**
 * One call, bounded, tried twice when a repeat is safe.
 *
 * How many goes is this function's decision, because it is about safety: a
 * request carrying a body is sent once, since a stream cannot be replayed and
 * a repeated write is a second write. Everything else gets two that share the
 * same total bound, which costs nothing and is the difference between failing
 * and succeeding when a route comes back between them. How long is the
 * caller's, because it is about patience — see `REACH_MS` and `SEND_MS`.
 */
export async function reach(
  url: string | URL,
  init: RequestInit = {},
  ms = REACH_MS,
): Promise<Response> {
  const attempts = init.body === undefined || init.body === null ? 2 : 1;
  const each = Math.ceil(ms / attempts);
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Not `AbortSignal.timeout`: that one cannot be called off, and it would go
    // on to cut the response body short at the same deadline.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      each,
    );
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      last = cause;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last;
}
