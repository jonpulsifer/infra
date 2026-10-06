/**
 * Where the console serves Monaco's AMD tree. The browser, the build and the
 * server all import it, so it imports nothing.
 */

/** Pinned in package.json too; test/web/monaco.test.ts holds them equal. */
export const MONACO_VERSION = '0.57.0';

/** The prefix sits outside the paths kthx owns on the shared host. */
export const MONACO_BASE = `/vendor/monaco/${MONACO_VERSION}/vs`;

/**
 * The loader's `vs` path. Monaco starts every worker from a `blob:` URL and
 * hands it this base, where a path with no origin cannot resolve.
 */
export function monacoLoaderBase(origin: string): string {
  return new URL(MONACO_BASE, origin).href;
}
