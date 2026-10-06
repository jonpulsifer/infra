/**
 * What the private control host serves under `/api/*` and `/cli/*`. The console
 * shares that origin by path and takes everything else, so a route here that
 * answered `text/html` or a script would run on the console's origin. The
 * allow-list is JSON, the CLI tarball, an empty 204, and the one escaped
 * not-here page.
 *
 * The server has no route table: `server/index.ts` is an if-chain. The probes
 * below are enumerated by hand, and a source scan fails the file when the
 * router names a path no probe covers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tarGz } from '../../cli/tar.ts';
import { ask, type Harness, withServer } from '../harness/server.ts';

const CONTROL = 'ops.kthx-control-types.test';
const SERVER = join(import.meta.dir, '..', '..', 'server');
const DIST = join(import.meta.dir, '..', '..', 'dist');

type Kind = 'json' | 'gzip' | 'page' | 'empty';

interface Probe {
  readonly method: string;
  readonly path: string;
  readonly kind: Kind;
  /** Asserted when set: an owner route must reach its handler's answer. */
  readonly status?: number;
  readonly token?: boolean;
  readonly body?: Uint8Array | string;
  readonly headers?: Record<string, string>;
}

const SITE = tarGz([
  { path: 'index.html', bytes: new TextEncoder().encode('<h1>hi</h1>') },
]);

const json = (
  method: string,
  path: string,
  rest: Partial<Probe> = {},
): Probe => ({
  method,
  path,
  kind: 'json',
  ...rest,
});

const page = (method: string, path: string): Probe => ({
  method,
  path,
  kind: 'page',
});

/** The owner routes come last: the final one deletes the site. */
function probes(name: string): Probe[] {
  const site = `/api/sites/${name}`;
  const upload = {
    token: true,
    headers: { 'content-type': 'application/gzip' },
  };
  return [
    json('GET', '/api'),
    json('GET', '/api/sites'),
    json('GET', '/api/sites?owner=me'),
    json('DELETE', '/api/sites'),
    json('PUT', '/api/sites'),
    json('GET', '/api/names/free-name-here'),
    json('POST', '/api/names/free-name-here'),
    json('GET', '/api/whoami'),
    json('POST', '/api/whoami'),
    json('GET', '/api/build'),
    json('POST', '/api/build'),
    json('GET', '/api/build/anything'),
    json('GET', '/api/engine'),
    json('GET', '/api/engine/sites'),
    json('GET', '/api/engine/sites/anything'),
    json('POST', '/api/engine/reservations'),
    json('DELETE', '/api/engine/reservations'),
    json('GET', '/api/nothing'),
    json('GET', '/api/'),
    json('GET', '/api/sdk.js'),
    json('GET', '/api/skill.md'),
    json('GET', '/api/files/x'),
    json('GET', '/api/db/x'),
    json('GET', '/api/ai/x'),
    json('GET', '/api/ws'),
    json('GET', '/api/me'),
    json('GET', '/api/mcp'),
    json('GET', '/api/..%2f..%2fetc'),
    json('GET', '/api/%ff'),
    json('GET', '/kthx/anything'),
    json('GET', `/api/sites/${name}-other`),
    json('GET', site),
    json('GET', site, { token: true, status: 200 }),
    json('GET', `${site}/releases`),
    json('POST', `${site}/releases`, { ...upload, body: SITE, status: 201 }),
    json('POST', `${site}/serve`, {
      token: true,
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    }),
    json('DELETE', `${site}/hold`, { token: true, status: 200 }),
    json('GET', `${site}/nothing`),
    json('POST', '/cli/kthx.tgz'),
    page('GET', '/cli'),
    page('GET', '/cli/'),
    page('GET', '/cli/nothing'),
    page('GET', '/cli/kthx.tgz/extra'),
    page('GET', '/cli/<script>alert(1)</script>'),
    { method: 'DELETE', path: site, kind: 'empty', token: true, status: 204 },
  ];
}

function mediaType(response: Response): string {
  const [type = ''] = (response.headers.get('content-type') ?? '').split(';');
  return type.trim().toLowerCase();
}

const TYPES: Record<Kind, string> = {
  json: 'application/json',
  gzip: 'application/gzip',
  page: 'text/html',
  empty: '',
};

async function answerTo(
  harness: () => Harness,
  probe: Probe,
  token: string,
): Promise<Response> {
  return harness().fetch(
    ask(probe.path, {
      method: probe.method,
      host: CONTROL,
      token: probe.token ? token : undefined,
      headers: probe.headers,
      body: probe.body as BodyInit | undefined,
    }),
  );
}

/** The not-here page is the only HTML, and it echoes nothing from the request. */
async function expectNotHerePage(response: Response) {
  expect(response.status).toBe(404);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.text();
  expect(body.startsWith('<!doctype html>')).toBe(true);
  expect(body).toContain('<h1>No site here yet.</h1>');
  expect(body).toContain(`<title>${CONTROL}</title>`);
  expect(body).not.toMatch(/<script/i);
  expect(body).not.toContain('alert(1)');
}

describe('the control host under /api and /cli', () => {
  const kthx = withServer({ controlHost: CONTROL });

  // The tarball only exists in a packed checkout; a stand-in keeps the probe
  // reachable and is removed again, and a real one is left alone.
  const TARBALL = join(DIST, 'kthx.tgz');
  let planted: 'file' | 'dir' | null = null;
  beforeAll(() => {
    if (Bun.file(TARBALL).size > 0) return;
    planted = existsSync(DIST) ? 'file' : 'dir';
    mkdirSync(DIST, { recursive: true });
    writeFileSync(TARBALL, tarGz([]));
  });
  afterAll(() => {
    if (planted === 'dir') rmSync(DIST, { recursive: true, force: true });
    if (planted === 'file') rmSync(TARBALL, { force: true });
  });

  test('answers every route in one of the allowed types, and nothing else', async () => {
    const name = kthx().name('types');
    const claimed = await kthx().fetch(
      ask('/api/sites', {
        method: 'POST',
        host: CONTROL,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    );
    expect(claimed.status).toBe(201);
    expect(mediaType(claimed)).toBe(TYPES.json);
    const { token } = (await claimed.json()) as { token: string };

    for (const probe of probes(name)) {
      const where = `${probe.method} ${probe.path}`;
      const response = await answerTo(kthx, probe, token);
      expect([where, mediaType(response)]).toEqual([where, TYPES[probe.kind]]);
      expect([where, response.headers.get('x-content-type-options')]).toEqual([
        where,
        'nosniff',
      ]);
      expect(response.status, where).toBeLessThan(500);
      if (probe.status !== undefined) {
        expect([where, response.status]).toEqual([where, probe.status]);
      }
      if (probe.kind === 'page') {
        await expectNotHerePage(response);
      } else {
        await response.arrayBuffer();
      }
    }
  });

  test('serves the tarball as gzip, whole, conditional and by HEAD', async () => {
    const first = await kthx().fetch(ask('/cli/kthx.tgz', { host: CONTROL }));
    expect(first.status).toBe(200);
    expect(mediaType(first)).toBe(TYPES.gzip);
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    const etag = first.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const head = await kthx().fetch(
      ask('/cli/kthx.tgz', { host: CONTROL, method: 'HEAD' }),
    );
    expect(mediaType(head)).toBe(TYPES.gzip);

    const cached = await kthx().fetch(
      ask('/cli/kthx.tgz', {
        host: CONTROL,
        headers: { 'if-none-match': etag },
      }),
    );
    expect(cached.status).toBe(304);
    expect(mediaType(cached)).toBe(TYPES.gzip);
  });

  test('is probed for every /api and /cli path the router names', async () => {
    const [index, sites, engine] = await Promise.all(
      ['index.ts', 'sites.ts', 'engine.ts'].map((file) =>
        Bun.file(join(SERVER, file)).text(),
      ),
    );
    const apex = (index ?? '').slice(
      (index ?? '').indexOf('async function apex('),
      (index ?? '').indexOf('interface Serving'),
    );
    const literal = (text: string, pattern: RegExp) =>
      [...text.matchAll(pattern)].map((hit) => hit[1] as string);

    const routed = [
      ...literal(
        apex,
        /\bpath(?:\.startsWith\(|\s*===\s*)'(\/(?:api|cli)[^']*)'/g,
      ),
      ...literal(apex, /segments\[2\] === '(\w+)'/g).map((s) => `/api/${s}`),
      ...literal(sites ?? '', /\btail === '(\w+)'/g).map((s) => `/${s}`),
      ...literal(engine ?? '', /\bcollection === '(\w+)'/g).map(
        (s) => `/api/engine/${s}`,
      ),
    ];
    // A scan that finds nothing would pass for the wrong reason.
    for (const known of [
      '/api/sites',
      '/api/engine/sites',
      '/serve',
      '/cli/kthx.tgz',
    ]) {
      expect(routed).toContain(known);
    }

    const probed = probes('x').map((probe) => probe.path);
    const missed = routed.filter(
      (route) =>
        !probed.some((path) =>
          route.startsWith('/api') || route.startsWith('/cli')
            ? path === route || path.startsWith(`${route}/`)
            : path.endsWith(route),
        ),
    );
    expect(missed).toEqual([]);
  });
});

describe('the control host with an engine configured', () => {
  const guarded = withServer({
    controlHost: CONTROL,
    engine: {
      issuer: 'http://issuer.invalid',
      audience: 'kthx',
      subject: 'system:serviceaccount:spindrift:spindrift',
    },
  });

  test('answers the engine routes with JSON before authentication', async () => {
    for (const probe of probes('unused').filter((p) =>
      p.path.startsWith('/api/engine'),
    )) {
      const where = `${probe.method} ${probe.path}`;
      const response = await answerTo(guarded, probe, '');
      expect([where, response.status]).toEqual([where, 401]);
      expect([where, mediaType(response)]).toEqual([where, TYPES.json]);
      expect([where, response.headers.get('x-content-type-options')]).toEqual([
        where,
        'nosniff',
      ]);
    }
  });
});
