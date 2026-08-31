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
 * The clock runs until the caller has the whole answer, headers and body, since
 * a socket that goes quiet mid-body hangs exactly as well as one that never
 * answers. The proxy is the exception and says so: a download it is passing
 * onward is as long as it is.
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
 * How many goes is this function's decision, because it is about safety, and
 * safety is the method: only `GET` and `HEAD` are repeated. A deadline is the
 * one failure the site may already have carried out, and "does this carry a
 * body" answers whether a repeat is *possible*, not whether it is *harmless* —
 * `DELETE /api/sites/:name` carries none and destroys a site. The two attempts
 * share one wall-clock bound rather than half of it each, so the first gets all
 * the patience the caller asked for and a second happens only when the first
 * failed fast enough to leave some: a refused or unroutable connect, which is
 * the flap this exists for. How long is the caller's decision, because it is
 * about patience — see `REACH_MS` and `SEND_MS`.
 *
 * The bound covers the answer's body too: a connection that goes dark one
 * packet after the headers is the same hang wearing a 200. `stream` opts out
 * for the one caller that hands the body onward and cannot know how long the
 * site means it to be.
 */
export async function reach(
  url: string | URL,
  init: RequestInit = {},
  ms = REACH_MS,
  /** Whether the caller passes the body on rather than reading it here. */
  stream = false,
): Promise<Response> {
  const method = init.method ?? 'GET';
  const attempts = method === 'GET' || method === 'HEAD' ? 2 : 1;
  const until = Date.now() + ms;
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const left = until - Date.now();
    if (left <= 0) break;
    // Not `AbortSignal.timeout`: that one cannot be called off, and the proxy
    // needs the bound lifted once the answer is on its way through.
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException('timed out', 'TimeoutError')),
      left,
    );
    try {
      const answer = await fetch(url, { ...init, signal: controller.signal });
      // Unref rather than clear: the reader is still on this clock, and a call
      // that is done must not hold the process open until the deadline.
      if (stream) clearTimeout(timer);
      else timer.unref();
      return answer;
    } catch (cause) {
      clearTimeout(timer);
      last = cause;
    }
  }
  throw last;
}
