/**
 * What a host answers: the apex's own pages, and on a site host the paths that
 * are the server's on every name in the zone. nginx serves a site's files.
 */
import { describe, expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readBundle } from '@repo/archive/bundle';
import { version } from '../../package.json' with { type: 'json' };
import { siteUrl } from '../../server/http.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const kthx = withServer();

async function published(
  files: Record<string, string>,
  label = 'notes',
): Promise<{ name: string; token: string; host: string }> {
  const site = await kthx().site(label);
  for (const [path, text] of Object.entries(files)) {
    kthx().gcs.put(kthx().bucket, `${site.name}/${path}`, text);
  }
  return site;
}

function get(host: string, path: string, init: RequestInit = {}) {
  return kthx().fetch(ask(path, { host, ...init }));
}

describe('the url a name gets', () => {
  test('is https in the zone, and reachable on a local run', () => {
    expect(siteUrl('kthx.dev')).toBe('https://kthx.dev');
    expect(siteUrl('kthx.dev', 'notes', '8080')).toBe('https://notes.kthx.dev');
    // Nothing terminates TLS for a local zone, and the URL needs its port.
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
    // The v2 API and install line, with nothing of the retired `/kthx/sites`.
    expect(html).toContain('const API = "/api/sites"');
    expect(html).toContain('"/api/sdk.js"');
    expect(html).toContain('bun add -g https://kthx.dev/cli/kthx.tgz');
    expect(html).toContain('kthx init');
    expect(html).toContain('gcloud auth application-default login');
    expect(html).not.toContain('kthx rollback');
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
    // Built into the process, so it caches like the SDK.
    expect(icon.headers.get('cache-control')).toBe('public, max-age=300');
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

    // `bun add -g <url>` needs one runnable file and no dependencies: a
    // `workspace:*` dependency packs to a version no registry has.
    await Bun.$`bun run pack`.cwd(join(import.meta.dir, '..', '..')).quiet();
    const tarball = await get(ZONE, '/cli/kthx.tgz');
    expect(tarball.status).toBe(200);
    expect(tarball.headers.get('content-type')).toBe('application/gzip');
    expect(tarball.headers.get('cache-control')).toBe('public, max-age=300');

    // The installed CLI's update check sends `HEAD` and reads both headers.
    const build = tarball.headers.get('x-kthx-build');
    const etag = tarball.headers.get('etag');
    expect(build).toMatch(/^\d+\.\d+\.\d+\+[0-9a-f]{12}$/);
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);
    const head = await get(ZONE, '/cli/kthx.tgz', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-kthx-build')).toBe(build);
    expect(head.headers.get('etag')).toBe(etag);
    expect(head.headers.get('content-type')).toBe('application/gzip');
    // The body is not asserted: dropping it for a HEAD is `Bun.serve`'s job.

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

    // `version.json` must name the build the header does, or the update check
    // nags forever.
    const bin = join(kthx().depotDir, 'kthx.js');
    await writeFile(bin, text('kthx.js'));
    await writeFile(
      join(kthx().depotDir, 'version.json'),
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

describe('a site host', () => {
  test('leaves every page to nginx, and answers its own paths', async () => {
    const site = await published({ 'about.html': 'about' }, 'pages');
    for (const path of ['/', '/about.html', '/favicon.ico']) {
      const page = await get(site.host, path);
      expect([path, page.status]).toEqual([path, 404]);
      expect(await page.text()).toContain('No site here yet.');
    }
  });

  test('a name nobody claimed, and one that was deleted', async () => {
    const free = await get(`nobody.${ZONE}`, '/api');
    expect(free.status).toBe(404);
    // Deeper labels are names no marker can match, not a way into the zone.
    expect((await get(`a.b.${ZONE}`, '/api')).status).toBe(404);

    const site = await published({}, 'doomed');
    await kthx().fetch(
      ask(`/api/sites/${site.name}`, { method: 'DELETE', token: site.token }),
    );
    expect((await get(site.host, '/api')).status).toBe(404);
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

  test('a folder file under a reserved prefix is never served', async () => {
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
