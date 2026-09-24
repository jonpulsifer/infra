/**
 * Adapts the Functions Framework's Express to a `fetch` handler, so both
 * surfaces run the same source. A string: it only runs inside the archive.
 *
 * ponytail: `env` is all of `process.env`, the runtime's variables included.
 */

export const SHIM_ENTRY_POINT = 'fn';

/**
 * Interpolated into the shim so the package's import scanner does not read it
 * as an undeclared dependency.
 */
const FRAMEWORK = '@google-cloud/functions-framework';

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
 * `type: module` because the author writes ESM; read as CommonJS, every
 * function fails on its first import.
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
