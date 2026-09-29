/**
 * Which failures are worth another attempt: a lost or refused connection, or
 * a server that asked the client to try again. Anything else, such as a
 * constraint or a pi validation error, fails the same way every time.
 */
const CONNECTION_CODES = new Set([
  'ERR_POSTGRES_CONNECTION_CLOSED',
  'ERR_POSTGRES_CONNECTION_TIMEOUT',
  'ERR_POSTGRES_EXPECTED_REQUEST',
  'ERR_POSTGRES_IDLE_TIMEOUT',
  'ERR_POSTGRES_LIFETIME_TIMEOUT',
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

const RETRYABLE_STATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
]);

export const ATTEMPTS = 4;
const BACKOFF_MS = [100, 300, 900];

export function isTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, errno } = error as { code?: unknown; errno?: unknown };
  if (typeof code === 'string' && CONNECTION_CODES.has(code)) return true;
  if (typeof errno !== 'string') return false;
  return errno.startsWith('08') || RETRYABLE_STATES.has(errno);
}

export function backoff(attempt: number): Promise<void> {
  return Bun.sleep(BACKOFF_MS[attempt - 1] ?? BACKOFF_MS.at(-1)!);
}

/** Runs an idempotent operation until it succeeds or fails for good. */
export async function retrying<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= ATTEMPTS || !isTransient(error)) throw error;
      await backoff(attempt);
    }
  }
}
