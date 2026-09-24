import { createHash, timingSafeEqual } from 'node:crypto';

// Hashing both sides to a fixed 32 bytes means the comparison never branches
// on the caller-supplied token's length, only on its content, over a fixed
// number of byte comparisons.
function fingerprint(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(fingerprint(a), fingerprint(b));
}

const BEARER = /^Bearer (.+)$/;

/** True only for an `Authorization: Bearer <token>` header matching `expected`. */
export function bearerMatches(
  header: string | null | undefined,
  expected: string,
): boolean {
  const match = header ? BEARER.exec(header) : null;
  return match ? constantTimeEqual(match[1] ?? '', expected) : false;
}
