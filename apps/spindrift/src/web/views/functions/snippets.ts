/**
 * Ready-made fragments for the Function editor's "Insert snippet" control.
 *
 * Each `code` is web-standard `fetch`/`Request`/`Response` — it runs
 * identically in the Bun preview, on Cloudflare Workers and on Cloud Run
 * functions. `placement` says where it is meant to land: `'body'` snippets
 * paste inside `fetch(request, env) { … }`; `'top'` snippets paste as a
 * top-level helper above it.
 */
export interface Snippet {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly placement: 'body' | 'top';
  readonly code: string;
}

export const SNIPPETS: readonly Snippet[] = [
  {
    id: 'bearer-auth',
    label: 'Bearer token check',
    description: 'Reject requests without a matching Authorization header.',
    placement: 'body',
    code: `// The token lives in source because functions carry no secrets yet.
const TOKEN = 'change-me';
if (request.headers.get('authorization') !== \`Bearer \${TOKEN}\`) {
  return new Response('unauthorized', { status: 401 });
}`,
  },
  {
    id: 'cors',
    label: 'CORS',
    description: 'Answer preflight requests and allow cross-origin calls.',
    placement: 'body',
    code: `const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization',
};
if (request.method === 'OPTIONS') {
  return new Response(null, { status: 204, headers: CORS });
}
// Spread CORS into every response this handler returns.`,
  },
  {
    id: 'json-body',
    label: 'Read a JSON body',
    description: 'Parse the request body, rejecting invalid JSON.',
    placement: 'body',
    code: `const payload = await request.json().catch(() => null);
if (payload === null) {
  return new Response('invalid json body', { status: 400 });
}`,
  },
  {
    id: 'router',
    label: 'Route by path',
    description: 'Branch on the request pathname.',
    placement: 'body',
    code: `const { pathname } = new URL(request.url);
switch (pathname) {
  case '/':
    return Response.json({ ok: true });
  default:
    return new Response('not found', { status: 404 });
}`,
  },
  {
    id: 'query',
    label: 'Query parameters',
    description: 'Read the request URL as a plain object.',
    placement: 'body',
    code: 'const query = Object.fromEntries(new URL(request.url).searchParams);',
  },
  {
    id: 'upstream',
    label: 'Call an upstream API',
    description: 'Proxy a GET to another service and relay its JSON.',
    placement: 'body',
    code: `const upstream = await fetch('https://example.com/api', {
  headers: { accept: 'application/json' },
});
if (!upstream.ok) {
  return new Response('upstream error', { status: 502 });
}
return Response.json(await upstream.json());`,
  },
  {
    id: 'html',
    label: 'Serve HTML',
    description: 'Return a plain HTML page.',
    placement: 'body',
    code: `return new Response('<h1>Hello</h1>', {
  headers: { 'content-type': 'text/html; charset=utf-8' },
});`,
  },
  {
    id: 'redirect',
    label: 'Redirect',
    description: 'Send the caller to another path.',
    placement: 'body',
    code: `return Response.redirect(new URL('/somewhere', request.url), 302);`,
  },
];
