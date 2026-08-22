/**
 * Whether a Function is answering yet.
 *
 * Measured fact: a Workers custom domain is created instantly, but the
 * hostname's TLS certificate takes on the order of 160s to issue, and a
 * `fetch` during that window throws rather than answering. Cloud Run function
 * URLs answer as soon as `deploy` returns. So readiness is defined the same
 * way for both surfaces, without either one naming itself here: **any HTTP
 * response is ready, a thrown fetch is not yet**.
 */
import type { Fetcher } from '../adapters/deploy/cloud/http.ts';

/** Whether a Function's URL is answering, and why not when it isn't. */
export interface FunctionProbe {
  readonly ready: boolean;
  /** A sentence an operator reads as-is. */
  readonly detail: string;
  /** ISO 8601, when this probe ran. */
  readonly checkedAt: string;
}

const DEFAULT_TIMEOUT_MS = 8_000;

const CERTIFICATE_DETAIL =
  'the edge is still issuing the TLS certificate for a new hostname — usually a few minutes';

const TIMEOUT_DETAIL = 'no answer within 8s';

/**
 * `GET` a Function's URL and say whether it answered.
 *
 * A thrown fetch is read for which kind of "not yet" it is: a certificate
 * still being issued is the one case worth naming apart, because it is the
 * one an operator can do nothing about but wait. Everything else — including
 * a plain timeout — falls through to the error's own message.
 */
export async function probeUrl(
  url: string,
  options: {
    /** Injected so a test can stand a fake far side behind the real client. */
    readonly fetch?: Fetcher;
    readonly now: () => Date;
    readonly timeoutMs?: number;
  },
): Promise<FunctionProbe> {
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const response = await send(
      new Request(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      }),
    );
    return {
      ready: true,
      detail: `answering HTTP ${response.status}`,
      checkedAt: options.now().toISOString(),
    };
  } catch (cause) {
    const name = cause instanceof Error ? cause.name : '';
    const message = cause instanceof Error ? cause.message : String(cause);
    const detail = message.includes('certificate')
      ? CERTIFICATE_DETAIL
      : name === 'AbortError' || name === 'TimeoutError'
        ? TIMEOUT_DETAIL
        : message;
    return { ready: false, detail, checkedAt: options.now().toISOString() };
  }
}
