/**
 * Whether a Function answers yet: any HTTP response is ready, a thrown fetch is
 * not. A new Workers custom domain throws until its TLS certificate issues.
 */
import type { Fetcher } from '../adapters/deploy/cloud/http.ts';

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

/** A certificate error is named apart: the operator can only wait it out. */
export async function probeUrl(
  url: string,
  options: {
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
