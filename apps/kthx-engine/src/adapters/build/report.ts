/**
 * The report a runner prints as one marker line in the build log core already
 * reads. The payload is base64, so CI log processing cannot alter it and
 * ordinary build output does not match it by accident.
 */
import { z } from 'zod';
import { digestSchema as digest } from '../../domain/digest.ts';

/**
 * Plain text: a CI's workflow-command syntax may be consumed by the runner's
 * own log processor.
 */
export const BUILD_REPORT_MARKER = 'spindrift-result';

/**
 * {@link parseBuildReport} does not check `bundleDigest`; `buildSucceeded`
 * compares it with the digest the route dispatched.
 */
export const buildReportSchema = z
  .object({
    bundleDigest: z.string().trim().min(1),
    digest,
    /** Every address the digest was pushed to. At least one, or nothing can pull it. */
    refs: z.array(z.string().trim().min(1)).min(1),
    /**
     * Null where the runner could not report one: a files artifact has no base,
     * and some runners cannot read their own provenance.
     */
    baseDigest: digest.nullable(),
    /** The backend's provenance document. Core refuses to sign a build without one. */
    statement: z.unknown().optional(),
    /** Registry reference to BuildKit's unsigned materials attestation. */
    buildkitProvenanceRef: z.string().trim().min(1).optional(),
    /** Registry reference to the SPDX SBOM attached beside it. */
    sbomRef: z.string().trim().min(1).optional(),
  })
  .strict();

export type BuildReport = z.infer<typeof buildReportSchema>;

/** Only tests call this; the build programs print the line themselves. */
export function encodeBuildReport(report: BuildReport): string {
  return `${BUILD_REPORT_MARKER} ${btoa(JSON.stringify(report))}`;
}

/**
 * The last valid report in the log, or `null`. A retried step prints more than
 * one, and the last describes what was pushed. Malformed marker lines are skipped.
 */
export function parseBuildReport(log: string): BuildReport | null {
  const prefix = `${BUILD_REPORT_MARKER} `;
  for (const line of log.split('\n').reverse()) {
    const at = line.indexOf(prefix);
    if (at === -1) continue;
    const payload = line.slice(at + prefix.length).trim();
    if (payload === '') continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(atob(payload));
    } catch {
      continue;
    }
    const parsed = buildReportSchema.safeParse(decoded);
    if (parsed.success) return parsed.data;
  }
  return null;
}
