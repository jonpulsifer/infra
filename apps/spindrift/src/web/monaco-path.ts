/**
 * Where the console serves Monaco's AMD tree. The browser, the build and the
 * server all import it, so it imports nothing.
 */

/** Pinned in package.json too; test/web/monaco.test.ts holds them equal. */
export const MONACO_VERSION = '0.52.2';

/**
 * The version is in the path, so every file under it is cached as immutable.
 * The prefix sits outside the paths kthx owns on the shared host.
 */
export const MONACO_BASE = `/vendor/monaco/${MONACO_VERSION}/vs`;
