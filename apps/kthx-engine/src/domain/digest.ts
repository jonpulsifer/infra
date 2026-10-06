/**
 * The one digest rule. Lowercase hex only: digests are compared for equality
 * end to end, and a case variant would name the same bytes yet compare unequal.
 */
import { z } from 'zod';

export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A digest, trimmed of the whitespace a copied-and-pasted one carries. */
export const digestSchema = z
  .string()
  .trim()
  .regex(DIGEST_PATTERN, 'must be a sha256 digest');

export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value.trim());
}
