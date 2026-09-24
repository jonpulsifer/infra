export const REASON_MAX_LEN = 200;

const NOT_PRINTABLE = /[^\x20-\x7E]/g;

/**
 * Strips to printable ASCII and caps the length, so a caller-supplied string
 * can never carry control characters into a dynamic variable an agent reads
 * out loud, or grow the ElevenLabs payload without bound.
 */
export function sanitizeReason(raw: unknown, maxLen = REASON_MAX_LEN): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(NOT_PRINTABLE, '').trim().slice(0, maxLen);
}
