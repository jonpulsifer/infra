/**
 * The client-safe edge of the archive upload boundary.
 *
 * The same split, and the same reason, as `command-path.ts`: `upload.ts` is the
 * server-side handler, and behind it sits `@repo/archive/archive-format` — which
 * imports `node:zlib` to transcode a ZIP. None of that belongs in the browser,
 * and importing the route constant from `upload.ts` is enough to drag all of it
 * in, because a value import is a module edge whatever the value is.
 *
 * So the one thing the browser needs — where to POST bytes — lives here, and
 * `upload.ts` re-exports it so there is exactly one definition.
 * `test/web/client-bundle.test.ts` builds the client and asserts the server
 * side stays out of it.
 */
export const UPLOAD_PATH = '/internal/upload';
