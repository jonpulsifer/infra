/**
 * What a digest is, in one place.
 *
 * §16 joins the source receipt to the provenance document on a digest, and the
 * deploy path pins an artifact by one — so "is this a digest" is a rule the
 * product enforces at four boundaries: a runner's build report, an archive
 * upload, an App creation, and a persisted creation draft. It was written out
 * four times, identically, which is three chances for the definitions to drift
 * apart and no way for a test to notice: a fake that hands back
 * `sha256:fake-0` only has to satisfy whichever copy happens to be on its path,
 * and the fakes satisfied none of them.
 *
 * Lowercase hex only, deliberately. A digest is compared for equality all the
 * way through — receipt against provenance, provenance against artifact — and a
 * value that differs only in case would compare unequal while naming the same
 * bytes, so the one canonical spelling is enforced at the boundary rather than
 * normalized later.
 */
import { z } from 'zod';

/** The only shape anything here accepts. */
export const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A digest, trimmed of the whitespace a copied-and-pasted one carries. */
export const digestSchema = z
  .string()
  .trim()
  .regex(DIGEST_PATTERN, 'must be a sha256 digest');

/** Whether a value is a digest, for the paths that answer rather than parse. */
export function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value.trim());
}
