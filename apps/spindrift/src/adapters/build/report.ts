/**
 * How a runner tells core what it built, on the one channel core already reads.
 *
 * §4 settles that **build logs are read, not pushed** — "reading is outbound
 * only, needs no public ingest endpoint, and surfaces the failures that happen
 * *before* the instrumented step". That decision has a consequence nobody states
 * but every route runs into: if core never exposes an ingest endpoint, a runner
 * has no way to hand back a digest either. So the result travels the same way
 * the logs do — the runner prints one line, core reads it out of the log it was
 * already fetching. No second channel, no callback, nothing to authenticate.
 *
 * **All three routes report this way, including the cloud builder.** Its API
 * does have a results field — but it is populated only for images the build
 * service itself pushed, and every route here pushes from BuildKit directly, so
 * that field is empty on exactly the builds that matter. One reporting path for
 * three routes also keeps §16's join real everywhere: the digest core checks is
 * the one the runner echoed, not one core already knew and copied.
 *
 * **Base64, so the log cannot corrupt the report.** A runner's stdout goes
 * through a CI's own log processing on the way here: it may be prefixed with a
 * timestamp, grouped, folded, or coloured. A base64 payload survives every one
 * of those, and — more to the point — cannot be *forged* by a build that
 * happens to print JSON, because the marker plus a valid base64 document is not
 * something an ordinary compiler emits.
 */
import { z } from 'zod';

/**
 * The prefix a report line starts with.
 *
 * Deliberately not a `::workflow-command::`: one CI's command syntax is that
 * CI's, and a marker that means something to the runner's own log processor is
 * a marker the runner's log processor may swallow.
 */
export const BUILD_REPORT_MARKER = 'spindrift-result';

/** A digest, in the only form anything here accepts. */
const digest = z
  .string()
  .trim()
  .regex(/^sha256:[0-9a-f]{64}$/, 'must be a sha256 digest');

/**
 * What a runner reports.
 *
 * `bundleDigest` is here, echoed rather than inferred, because §16 makes it the
 * join between the source receipt and the provenance document — and a route
 * that echoes a digest it was *not* given is a route whose provenance points at
 * the wrong source. {@link parseBuildReport} does not check that; the adapter
 * does, against what it dispatched, which is the only place the expected value
 * exists.
 */
export const buildReportSchema = z
  .object({
    bundleDigest: z.string().trim().min(1),
    digest,
    /** Every address the digest was pushed to. At least one, or nothing can pull it. */
    refs: z.array(z.string().trim().min(1)).min(1),
    /**
     * The base image, from the builder's own materials (§16). Null where the
     * runner could not report one — a files artifact has no base, and a runner
     * without the tooling to read its own provenance says so rather than
     * guessing. Stale bases are surfaced, never auto-corrected.
     */
    baseDigest: digest.nullable(),
    /**
     * The backend's provenance document, opaque here and read by core (§16).
     * Absent where the backend produced none; a route whose provenance is
     * missing is one Task 26 refuses to sign, which is the point.
     */
    statement: z.unknown().optional(),
  })
  .strict();

export type BuildReport = z.infer<typeof buildReportSchema>;

/** Compose the line a runner prints. Used by the tests and by nothing in `src/`. */
export function encodeBuildReport(report: BuildReport): string {
  return `${BUILD_REPORT_MARKER} ${btoa(JSON.stringify(report))}`;
}

/**
 * The report a log carries, or `null` when it carries none.
 *
 * **The last marker wins.** A build that retried a step prints two, and the one
 * that describes what was actually pushed is the last one — taking the first
 * would report a digest that a later push replaced.
 *
 * Malformed is the same answer as absent, on purpose. The caller's next move is
 * identical either way — fail the build and say the runner reported nothing
 * usable — and distinguishing them would mean this function had an opinion
 * about *why* a runner misbehaved.
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
