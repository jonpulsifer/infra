/**
 * What makes a `fetch` handler run on Cloud Run functions.
 *
 * The runtime speaks Express through the Functions Framework; a function speaks
 * `Request` in and `Response` out. This is the adapter between them, shipped in
 * the archive alongside the author's `index.mjs` so both surfaces run exactly
 * the same source — the whole point of picking one handler shape.
 *
 * It is a string rather than a module because it is never executed here: it is
 * a file in an archive, compiled by somebody else's buildpack against a
 * dependency this app does not have.
 *
 * ponytail: `process.env` is the whole of `env`. Per-function config and
 * secrets are the promotion path `contract.ts` names.
 */

/** The entry point name the build config declares. */
export const SHIM_ENTRY_POINT = 'fn';

/**
 * The framework the runtime speaks, named once.
 *
 * Interpolated into the shim rather than written into it, so the one place this
 * app's own import scanner would read as an undeclared dependency does not
 * exist: the specifier belongs to the archive's manifest, not to this package.
 */
const FRAMEWORK = '@google-cloud/functions-framework';

/** The range the archive's manifest pins the framework to. */
const FRAMEWORK_RANGE = '^5';

export const SHIM = `import * as ff from ${JSON.stringify(FRAMEWORK)};
import handler from './index.mjs';

ff.http('${SHIM_ENTRY_POINT}', async (req, res) => {
  const url = new URL(
    req.originalUrl ?? req.url ?? '/',
    'https://' + (req.headers.host ?? 'localhost'),
  );
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const one of value) headers.append(key, one);
    else if (value !== undefined) headers.set(key, value);
  }
  const body =
    req.method === 'GET' || req.method === 'HEAD' ? undefined : req.rawBody;
  const response = await handler.fetch(
    new Request(url, { method: req.method, headers, body }),
    process.env,
    { waitUntil() {} },
  );
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.end(Buffer.from(await response.arrayBuffer()));
});
`;

/**
 * The archive's manifest.
 *
 * `type: module` is load-bearing: the author writes ESM, so a package the
 * buildpack reads as CommonJS makes every function fail on its first import.
 */
export function packageJson(id: string): string {
  return `${JSON.stringify(
    {
      name: id,
      private: true,
      type: 'module',
      main: 'shim.mjs',
      dependencies: { [FRAMEWORK]: FRAMEWORK_RANGE },
    },
    null,
    2,
  )}\n`;
}
