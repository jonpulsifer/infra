/**
 * What a host answers: the apex's own pages, a site's files off the volume, and
 * the paths that are the server's on every name in the zone.
 */
import { describe, expect, test } from 'bun:test';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBundle } from '@repo/archive/bundle';
import { tarGz } from '../../cli/tar.ts';
import { version } from '../../package.json' with { type: 'json' };
import { siteUrl } from '../../server/http.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `203.0.113.${nextAddress % 250}`;
}

function bundle(files: Record<string, string>): Uint8Array<ArrayBuffer> {
  return tarGz(
    Object.entries(files).map(([path, text]) => ({
      path,
      bytes: new TextEncoder().encode(text),
    })),
  );
}

/** A claimed name serving these files. */
async function published(
  files: Record<string, string>,
  label = 'notes',
): Promise<{ name: string; token: string; host: string }> {
  // Prefixed: a claim makes a Postgres database and role of this name on a
  // server this suite shares.
  const name = kthx().name(label);
  const claimed = await kthx()
    .fetch(
      ask('/api/sites', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
        address: address(),
      }),
    )
    .then((response) => response.json());
  const uploaded = await kthx().fetch(
    ask(`/api/sites/${name}/releases`, {
      method: 'POST',
      token: claimed.token,
      body: bundle(files),
      address: address(),
    }),
  );
  expect(uploaded.status).toBe(201);
  return { name, token: claimed.token, host: `${name}.${ZONE}` };
}

function get(host: string, path: string, init: RequestInit = {}) {
  return kthx().fetch(ask(path, { host, ...init }));
}

describe('the url a name gets', () => {
  test('is https in the zone, and reachable on a local run', () => {
    expect(siteUrl('kthx.dev')).toBe('https://kthx.dev');
    expect(siteUrl('kthx.dev', 'notes', '8080')).toBe('https://notes.kthx.dev');
    // Nothing terminates TLS in front of a local zone, and a URL without the
    // port it is listening on is one nobody can open.
    expect(siteUrl('kthx.localhost', 'notes', '4321')).toBe(
      'http://notes.kthx.localhost:4321',
    );
    expect(siteUrl('kthx.localhost', 'notes')).toBe(
      'http://notes.kthx.localhost',
    );
  });
});

describe('the apex', () => {
  test('serves the landing page, the SDK, the reference and the icon', async () => {
    const landing = await get(ZONE, '/');
    expect(landing.status).toBe(200);
    expect(landing.headers.get('cache-control')).toBe('no-cache');
    const html = await landing.text();
    expect(html).toContain('<!doctype html>');
    // The asset on disk is still v1's, because the apex Spindrift serves reads
    // the same file; this process rewrites it as it serves. Every swap has to
    // land: one that stops matching leaves v1's copy on a v2 page in silence.
    expect(html).toContain('const API = "/api/sites"');
    expect(html).toContain('"/api/sdk.js"');
    expect(html).toContain('bun add -g https://kthx.dev/cli/kthx.tgz');
    expect(html).toContain('kthx init');
    expect(html).toContain('kthx rollback');
    expect(html).not.toContain('/kthx/sites');
    expect(html).not.toContain('/_/sdk.js');
    expect(html).not.toContain('alias kthx=');
    expect(html).not.toContain('sdk in local mode');
    expect(html).not.toContain('come from Spindrift');

    const sdk = await get(ZONE, '/sdk.js');
    expect(sdk.status).toBe(200);
    expect(sdk.headers.get('cache-control')).toBe('public, max-age=300');

    const skill = await get(ZONE, '/skill.md');
    expect(skill.status).toBe(200);
    expect(skill.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8',
    );
    expect(await skill.text()).toContain('/api/db');

    const icon = await get(ZONE, '/favicon.ico');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/x-icon');
  });

  test('answers /healthz, retires /kthx/, and 404s an unknown API path', async () => {
    expect((await get(ZONE, '/healthz')).status).toBe(200);

    const retired = await get(ZONE, '/kthx/sites/notes');
    expect(retired.status).toBe(410);
    expect((await retired.json()).code).toBe('GONE');

    const unknown = await get(ZONE, '/api/db');
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe('NOT_FOUND');
  });

  test('serves the CLI tarball a checkout has packed, and 404s one it has not', async () => {
    const dist = join(import.meta.dir, '..', '..', 'dist');
    await rm(dist, { recursive: true, force: true });
    expect((await get(ZONE, '/cli/kthx.tgz')).status).toBe(404);

    // The whole install line, end to end. `bun add -g <url>` reads exactly
    // this tarball, so it has to carry one runnable file and a manifest with no
    // dependencies at all: `@repo/archive` and `@repo/kthx` are `workspace:*`,
    // which `bun pm pack` rewrites to a version the public registry has never
    // heard of, and an install of that resolves nothing.
    await Bun.$`bun run pack`.cwd(join(import.meta.dir, '..', '..')).quiet();
    const tarball = await get(ZONE, '/cli/kthx.tgz');
    expect(tarball.status).toBe(200);
    expect(tarball.headers.get('content-type')).toBe('application/gzip');
    expect(tarball.headers.get('cache-control')).toBe('public, max-age=300');

    // The two headers the installed CLI's update check reads. `HEAD` is what it
    // actually sends, and it must carry both without the body.
    const build = tarball.headers.get('x-kthx-build');
    const etag = tarball.headers.get('etag');
    expect(build).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const head = await get(ZONE, '/cli/kthx.tgz', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-kthx-build')).toBe(build);
    expect(head.headers.get('etag')).toBe(etag);
    expect(head.headers.get('content-type')).toBe('application/gzip');
    // The body is not asserted: this calls the handler directly, and dropping
    // it for a HEAD is `Bun.serve`'s job rather than this code's.

    const cached = await get(ZONE, '/cli/kthx.tgz', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(cached.status).toBe(304);

    const packed = readBundle(new Uint8Array(await tarball.arrayBuffer()));
    const text = (path: string) =>
      new TextDecoder().decode(
        packed.find((file) => file.path.endsWith(path))?.bytes ??
          new Uint8Array(),
      );
    const manifest = JSON.parse(text('package.json')) as {
      version: string;
      bin: Record<string, string>;
      files: string[];
      dependencies?: unknown;
    };
    expect(manifest.version).toBe(version);
    expect(manifest.bin).toEqual({ kthx: 'kthx.js' });
    expect(manifest.dependencies).toBeUndefined();

    // `version.json` rides along in the tarball so an installed copy knows which
    // build it is without asking. It has to be the build the header names, or
    // the update check nags for ever.
    const bin = join(kthx().sitesDir, 'kthx.js');
    await writeFile(bin, text('kthx.js'));
    await writeFile(
      join(kthx().sitesDir, 'version.json'),
      text('version.json'),
    );
    expect(manifest.files).toEqual(['kthx.js', 'version.json']);
    const printed = (
      await Bun.$`bun ${bin} --version`
        .env({ ...process.env, KTHX_NO_UPDATE_CHECK: '1' })
        .quiet()
        .text()
    ).trim();
    expect(printed).toBe(`${version} · ${build?.split('+')[1]}`);
  }, 60_000);

  test('a host outside the zone learns nothing', async () => {
    const stranger = await get('example.test', '/');
    expect(stranger.status).toBe(404);
    expect((await stranger.json()).code).toBe('NOT_FOUND');
  });
});

describe('a site', () => {
  test('serves the release it is on, with a strong etag', async () => {
    const site = await published({
      'index.html': '<h1>hi</h1>',
      'app.js': 'console.log(1)',
      'docs/index.html': 'docs',
    });

    const root = await get(site.host, '/');
    expect(root.status).toBe(200);
    expect(await root.text()).toBe('<h1>hi</h1>');
    expect(root.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(root.headers.get('cache-control')).toBe('public, max-age=60');
    expect(root.headers.get('x-content-type-options')).toBe('nosniff');

    const script = await get(site.host, '/app.js');
    expect(script.headers.get('content-type')).toBe(
      'text/javascript; charset=utf-8',
    );

    // A directory resolves through its index, with and without the slash.
    expect((await get(site.host, '/docs/')).status).toBe(200);
    expect(await (await get(site.host, '/docs')).text()).toBe('docs');

    const etag = root.headers.get('etag') ?? '';
    expect(etag).toMatch(/^"[0-9a-f]{64}:\/index\.html"$/);
    const again = await get(site.host, '/', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);

    const head = await get(site.host, '/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBe(etag);
  });

  test('200.html is the SPA fallback and 404.html is the miss', async () => {
    const spa = await published(
      { 'index.html': 'home', '200.html': 'app-shell' },
      'shell',
    );
    const deep = await get(spa.host, '/some/route');
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe('app-shell');

    const own = await published(
      { 'index.html': 'home', '404.html': 'not found' },
      'plain',
    );
    const missing = await get(own.host, '/nope');
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe('not found');
  });

  test('a bundle with neither fallback gets the kthx page', async () => {
    const site = await published({ 'index.html': 'home' }, 'bare');
    const missing = await get(site.host, '/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(await missing.text()).toContain('No site here yet.');
  });

  test('the generic icon fills in, and a bundle that ships one wins', async () => {
    const site = await published({ 'index.html': 'home' }, 'iconless');
    const generic = await get(site.host, '/favicon.ico');
    expect(generic.status).toBe(200);
    expect(generic.headers.get('content-type')).toBe('image/x-icon');

    const own = await published(
      { 'index.html': 'home', 'favicon.ico': 'mine' },
      'iconful',
    );
    expect(await (await get(own.host, '/favicon.ico')).text()).toBe('mine');
  });

  test('a path that leaves the release, or is not a regular file, is a miss', async () => {
    const site = await published({ 'index.html': 'home' }, 'guarded');
    const secret = join(kthx().sitesDir, 'secret.txt');
    await writeFile(secret, 'not yours');
    await symlink(secret, join(kthx().sitesDir, site.name, '1', 'link.txt'));

    // The symlink is in the release and still refused: `lstat`, not `stat`.
    const linked = await get(site.host, '/link.txt');
    expect(linked.status).toBe(404);
    expect(await linked.text()).not.toContain('not yours');

    // A literal `..` is normalised away by the URL parser; a percent-encoded
    // one survives it and is what the decoded-path guard is for.
    for (const path of [
      '/../secret.txt',
      '/a/../../secret.txt',
      '/%2e%2e/secret.txt',
      '/sub/%2E%2E/%2E%2E/secret.txt',
    ]) {
      const escaping = await get(site.host, path);
      expect(escaping.status).toBe(404);
      expect(await escaping.text()).not.toContain('not yours');
    }
  });

  test('writes to a static path are 405', async () => {
    const site = await published({ 'index.html': 'home' }, 'readonly');
    const written = await get(site.host, '/index.html', { method: 'POST' });
    expect(written.status).toBe(405);
    expect((await written.json()).code).toBe('METHOD_NOT_ALLOWED');
  });

  test('a name nobody claimed, and one that was deleted', async () => {
    const free = await get(`nobody.${ZONE}`, '/');
    expect(free.status).toBe(404);
    expect(await free.text()).toContain('No site here yet.');
    // Deeper labels are names no row can match, not a way into the zone.
    expect((await get(`a.b.${ZONE}`, '/')).status).toBe(404);

    const site = await published({ 'index.html': 'home' }, 'doomed');
    await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    const gone = await get(site.host, '/');
    expect(gone.status).toBe(410);
    expect(await gone.text()).toContain('This site is gone.');
    expect((await get(site.host, '/api')).status).toBe(410);
  });
});

describe('the paths a site does not own', () => {
  test('/_/ is retired with a hint, everywhere in the zone', async () => {
    const site = await published({ 'index.html': 'home' }, 'legacy');
    for (const host of [site.host, `nobody.${ZONE}`]) {
      const retired = await kthx().fetch(
        ask('/_/db/votes', { host, method: 'GET' }),
      );
      expect(retired.status).toBe(410);
      const body = await retired.json();
      expect(body.code).toBe('GONE');
      expect(body.message).toContain('/skill.md');
    }
  });

  test('a bundle file under a reserved prefix is never served', async () => {
    const site = await published(
      {
        'index.html': 'home',
        'api/secrets.json': '{"leak":true}',
        '_/old.json': '{}',
        'files/thing.txt': 'bytes',
      },
      'sneaky',
    );
    expect((await get(site.host, '/api/secrets.json')).status).toBe(404);
    expect((await get(site.host, '/files/thing.txt')).status).toBe(404);
    expect((await get(site.host, '/_/old.json')).status).toBe(410);
  });

  test('/api answers what it is, and /api/sdk.js the SDK', async () => {
    const site = await published({ 'index.html': 'home' }, 'known');
    const api = await get(site.host, '/api');
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({
      name: site.name,
      url: `https://${site.name}.kthx.test`,
      docs: 'https://kthx.test/skill.md',
    });
    expect(api.headers.get('cache-control')).toBe('no-store');

    const sdk = await get(site.host, '/api/sdk.js');
    expect(sdk.status).toBe(200);
    expect(sdk.headers.get('cache-control')).toBe('public, max-age=300');

    // The control API is the apex's alone.
    expect((await get(site.host, `/api/sites/${site.name}`)).status).toBe(404);
  });
});
