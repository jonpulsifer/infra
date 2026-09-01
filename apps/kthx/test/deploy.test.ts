/**
 * The client against a `Bun.serve` that speaks the contract: what it sends,
 * what it writes down, and how it fails.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBundle } from '@repo/archive/bundle';
import {
  deploy,
  init,
  KthxError,
  ls,
  nuke,
  openSite,
  release,
  rm,
  rollback,
  siteOrigin,
  sitesFile,
} from '../cli/main.ts';

interface Upload {
  readonly name: string;
  readonly bearer: string | null;
  readonly filename: string | null;
  readonly paths: string[];
}

const NAME = /^[a-z]+-[a-z]+-\d\d$/;
const calls: { method: string; path: string; body: unknown }[] = [];
const uploads: Upload[] = [];
const tokens = new Map<string, string>();
const deleted: string[] = [];
let n = 0;
/** How many claims to answer TAKEN before accepting one. */
let refuseClaims = 0;

/** The operator key this stub answers `DELETE /api/sites` for. */
const ADMIN = 'admin-key-for-the-stub';
/** Every site the stub had when it was last nuked. */
let nuked: number | null = null;

const SKILL = '# kthx\n\nthe apex copy\n';
/** The apex having no reference to hand, so the packed copy is the answer. */
let skillDown = false;

const stub = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const [, , , name, act] = pathname.split('/');
    if (pathname === '/skill.md') {
      return skillDown
        ? new Response(null, { status: 503 })
        : new Response(SKILL);
    }
    if (request.method === 'GET' && pathname === '/api/sites') {
      calls.push({ method: 'GET', path: pathname, body: null });
      return Response.json({
        items: [...tokens.keys()].map((claimed) => ({
          name: claimed,
          url: `https://${claimed}.kthx.test`,
          serving: 3,
          releases: 3,
          at: '2026-08-31T00:00:00.000Z',
        })),
        next: null,
      });
    }
    if (request.method === 'POST' && pathname === '/api/sites') {
      const body = (await request.json()) as { name: string };
      calls.push({ method: 'POST', path: pathname, body });
      if (
        refuseClaims-- > 0 ||
        tokens.has(body.name) ||
        body.name === 'taken'
      ) {
        return Response.json(
          { code: 'TAKEN', message: `${body.name} is taken` },
          { status: 409 },
        );
      }
      const token = `tok-${body.name}`;
      tokens.set(body.name, token);
      return Response.json(
        { name: body.name, url: `https://${body.name}.kthx.test`, token },
        { status: 201 },
      );
    }
    if (request.method === 'DELETE' && pathname === '/api/sites') {
      calls.push({ method: 'DELETE', path: pathname, body: null });
      if (request.headers.get('authorization') !== `Bearer ${ADMIN}`) {
        return Response.json(
          { code: 'FORBIDDEN', message: 'that does not open this site' },
          { status: 403 },
        );
      }
      nuked = tokens.size;
      tokens.clear();
      return Response.json({ deleted: nuked, failed: 0 });
    }
    const bearer = request.headers.get('authorization')?.slice(7) ?? null;
    if (name === undefined || tokens.get(name) !== bearer) {
      return Response.json(
        { code: 'FORBIDDEN', message: 'that token does not open this site' },
        { status: 403 },
      );
    }
    if (request.method === 'POST' && act === 'releases') {
      const paths = readBundle(new Uint8Array(await request.arrayBuffer())).map(
        (file) => file.path,
      );
      uploads.push({
        name,
        bearer,
        filename: request.headers.get('x-filename'),
        paths,
      });
      if (!paths.includes('/index.html')) {
        return Response.json(
          { code: 'NO_INDEX', message: 'no index.html' },
          { status: 400 },
        );
      }
      n += 1;
      return Response.json(
        {
          n,
          digest: 'a'.repeat(64),
          url: `https://${name}.kthx.test`,
          serving: n,
        },
        { status: 201 },
      );
    }
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ method: request.method, path: pathname, body });
    if (request.method === 'DELETE' && act === undefined) {
      deleted.push(name);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'GET' && act === undefined) {
      return Response.json({
        name,
        url: `https://${name}.kthx.test`,
        serving: 3,
        held: false,
        releases: [3, 2, 1].map((r) => ({
          n: r,
          digest: 'b'.repeat(64),
          size: 2048,
          at: '2026-08-31T00:00:00.000Z',
        })),
        usage: {
          db_bytes: 1024,
          files_bytes: 0,
          ai_requests_today: 2,
          ai_tokens_today: 40,
        },
        quotas: {
          db_bytes: 268435456,
          files_bytes: 268435456,
          ai_requests_day: 200,
          ai_tokens_day: 500000,
        },
      });
    }
    if (act === 'serve') {
      return Response.json({ serving: (body as { n: number }).n, held: true });
    }
    if (act === 'hold') return Response.json({ held: false, serving: 3 });
    return new Response(null, { status: 404 });
  },
});
afterAll(() => stub.stop(true));

function site(files: Record<string, string> = { 'index.html': '<h1>hi</h1>' }) {
  const dir = mkdtempSync(join(tmpdir(), 'kthx-site-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

/** Everything a command printed, so a listing can be read back. */
async function capture(run: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const printed = console.log;
  console.log = (...parts: unknown[]) => lines.push(parts.join(' '));
  try {
    await run();
  } finally {
    console.log = printed;
  }
  return lines.join('\n');
}

const cwd = process.cwd();
beforeEach(() => {
  process.env.KTHX_ORIGIN = `${stub.url.origin}/`;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kthx-config-'));
  calls.length = 0;
  uploads.length = 0;
  deleted.length = 0;
  tokens.clear();
  n = 0;
  nuked = null;
  refuseClaims = 0;
  skillDown = false;
  // The nuke reads it from the environment, so no test may inherit one.
  delete process.env.KTHX_ADMIN_KEY;
});
// Every command writes `kthx.json` relative to where it runs, so no test may
// leave the process standing somewhere else.
afterEach(() => process.chdir(cwd));

describe('deploy', () => {
  test('mints a name, keeps the token out of the directory, and uploads the tar', async () => {
    const dir = site({
      'index.html': '<h1>hi</h1>',
      'app.js': 'x',
      '.env': 'SECRET',
      'node_modules/x.js': 'x',
    });
    process.chdir(dir);
    const first = await deploy('.');
    const { name } = JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'));
    expect(name).toMatch(NAME);
    expect(first.url).toBe(`https://${name}.kthx.test`);

    const stored = JSON.parse(readFileSync(sitesFile(), 'utf8'));
    expect(stored[stub.url.origin][name]).toBe(`tok-${name}`);
    expect(statSync(sitesFile()).mode & 0o777).toBe(0o600);

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filename).toBe('site.tar.gz');
    expect(uploads[0]!.paths).toEqual(['/app.js', '/index.html']);

    // The second deploy reuses the name and claims nothing.
    const second = await deploy('.');
    expect(second.n).toBe(2);
    expect(calls.filter((call) => call.path === '/api/sites')).toHaveLength(1);
    expect(uploads[1]!.bearer).toBe(`tok-${name}`);
  });

  test('rolls the dice again when a minted name is taken', async () => {
    refuseClaims = 1;
    const dir = site();
    process.chdir(dir);
    await deploy('.');
    const claims = calls.filter((call) => call.path === '/api/sites');
    expect(claims).toHaveLength(2);
    expect(claims[0]!.body).not.toEqual(claims[1]!.body);
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual(
      claims[1]!.body,
    );
  });

  test('--name claims that name, reuses a known one, and refuses to rename', async () => {
    const dir = site();
    process.chdir(dir);
    await deploy('.', { name: 'notes' });
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual({
      name: 'notes',
    });
    const other = site();
    process.chdir(other);
    await expect(deploy('.', { name: 'taken' })).rejects.toMatchObject({
      code: 'TAKEN',
    });
    process.chdir(dir);
    await expect(deploy('.', { name: 'other' })).rejects.toMatchObject({
      code: 'NAMED',
    });

    // A name this machine already holds a token for is reused, not re-claimed.
    const again = site();
    process.chdir(again);
    await deploy('.', { name: 'notes' });
    expect(calls.filter((call) => call.path === '/api/sites')).toHaveLength(2);
  });

  test('deploys a subdirectory under the project root’s name', async () => {
    const project = site({ 'dist/index.html': '<h1>built</h1>' });
    process.chdir(project);
    await deploy('dist');
    const { name } = JSON.parse(
      readFileSync(join(project, 'kthx.json'), 'utf8'),
    );
    expect(name).toMatch(NAME);
    // The name lives in the project, never in the directory a build rewrites.
    expect(() => statSync(join(project, 'dist', 'kthx.json'))).toThrow();
    expect(uploads[0]!.paths).toEqual(['/index.html']);
    expect(uploads[0]!.name).toBe(name);
  });

  test("fails with the server's code, and without a token", async () => {
    const dir = site({ 'readme.md': 'no index' });
    process.chdir(dir);
    const error = await deploy('.').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(KthxError);
    expect((error as KthxError).code).toBe('NO_INDEX');

    const orphan = site();
    writeFileSync(join(orphan, 'kthx.json'), '{"name":"lost"}');
    process.chdir(orphan);
    await expect(deploy('.')).rejects.toMatchObject({ code: 'NO_TOKEN' });
  });
});

describe('init', () => {
  test('claims, writes the apex reference, and starts an empty directory off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kthx-init-'));
    const name = await init(dir);
    expect(name).toMatch(NAME);
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual({
      name,
    });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '/api/sdk.js',
    );
  });

  test('keeps a SKILL.md somebody wrote', async () => {
    const dir = site({ 'index.html': '<h1>mine</h1>', 'SKILL.md': '# mine\n' });
    await init(dir, { name: 'notes' });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('# mine\n');
  });

  test('leaves a directory that has files alone, and falls back when the apex is away', async () => {
    const dir = site({ 'index.html': '<h1>mine</h1>' });
    process.env.KTHX_ORIGIN = stub.url.origin;
    await init(dir, { name: 'notes' });
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('<h1>mine</h1>');

    // An apex with no reference to hand still leaves one behind: the copy this
    // build was packed with.
    const offline = mkdtempSync(join(tmpdir(), 'kthx-init-'));
    writeFileSync(join(offline, 'kthx.json'), '{"name":"notes"}');
    skillDown = true;
    await init(offline);
    const bundled = readFileSync(join(offline, 'SKILL.md'), 'utf8');
    expect(bundled).not.toBe(SKILL);
    expect(bundled).toContain('/api/db');
  });
});

describe('rollback, release, ls and rm', () => {
  test('serve the release before the serving one, or the one named, then unhold', async () => {
    const dir = site();
    process.chdir(dir);
    await deploy('.', { name: 'notes' });
    expect(await rollback('.')).toBe(2);
    expect(await rollback('.', 1)).toBe(1);
    expect(await release('.')).toBe(3);
    expect(
      calls.filter((call) => call.path.startsWith('/api/sites/notes')),
    ).toEqual([
      { method: 'GET', path: '/api/sites/notes', body: null },
      { method: 'POST', path: '/api/sites/notes/serve', body: { n: 2 } },
      { method: 'GET', path: '/api/sites/notes', body: null },
      { method: 'POST', path: '/api/sites/notes/serve', body: { n: 1 } },
      { method: 'DELETE', path: '/api/sites/notes/hold', body: null },
    ]);
  });

  test('ls reads the site, and rm needs the name typed back', async () => {
    const dir = site();
    process.chdir(dir);
    await deploy('.', { name: 'notes' });

    const found = await ls('.');
    expect(found?.serving).toBe(3);
    expect(found?.releases).toHaveLength(3);

    await rm('.', () => 'nope');
    expect(deleted).toEqual([]);
    expect(
      JSON.parse(readFileSync(sitesFile(), 'utf8'))[stub.url.origin].notes,
    ).toBe('tok-notes');

    await rm('.', () => 'notes');
    expect(deleted).toEqual(['notes']);
    expect(
      JSON.parse(readFileSync(sitesFile(), 'utf8'))[stub.url.origin],
    ).toEqual({});
  });

  test('nuke asks for the operator key, then for NUKE', async () => {
    const dir = site();
    process.chdir(dir);
    await deploy('.', { name: 'notes' });
    const sent = () =>
      calls.filter(
        (call) => call.method === 'DELETE' && call.path === '/api/sites',
      );

    // No key is not a request the apex refuses: it is one that is never sent.
    await expect(nuke({}, () => 'NUKE')).rejects.toMatchObject({
      code: 'NO_ADMIN_KEY',
    });
    expect(sent()).toHaveLength(0);

    // Anything but NUKE, and a `prompt` with no terminal to ask on, delete
    // nothing — `--yes` is the only way past it without typing.
    process.env.KTHX_ADMIN_KEY = ADMIN;
    await nuke({}, () => 'nope');
    await nuke({}, () => null);
    expect(sent()).toHaveLength(0);

    const said = await capture(() => nuke({}, () => 'NUKE'));
    expect(said).toContain('1 deleted');
    expect(said).toContain('claimable again');
    expect(nuked).toBe(1);
    expect(sent()).toHaveLength(1);

    // Every token this machine held opens a name anyone may now claim, so the
    // store is emptied the way `rm` empties the one entry it invalidated.
    expect(
      JSON.parse(readFileSync(sitesFile(), 'utf8'))[stub.url.origin],
    ).toEqual({});
  });

  test('nuke with the wrong key is refused by the apex', async () => {
    const dir = site();
    process.chdir(dir);
    await deploy('.', { name: 'notes' });
    process.env.KTHX_ADMIN_KEY = 'not-the-key';
    await expect(nuke({ yes: true })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(nuked).toBeNull();
  });

  test('every command but init, deploy and dev needs a name', async () => {
    const dir = site();
    process.chdir(dir);
    for (const command of [rollback, release]) {
      await expect(command('.')).rejects.toMatchObject({ code: 'NO_NAME' });
    }
  });

  test('ls with no kthx.json lists every site this machine has a token for', async () => {
    process.chdir(site());
    await deploy('.', { name: 'notes' });
    process.chdir(site());
    await deploy('.', { name: 'other' });
    // A directory that is not a site: the question is "which did I claim?",
    // and sites.json is the answer.
    process.chdir(site());

    const printed = await capture(() => ls('.'));
    expect(printed).toContain('notes');
    expect(printed).toContain('other');
    expect(printed).toContain('https://notes.kthx.test');
    // One GET for each site, and the public directory is not asked for.
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.path.startsWith('/api/sites/'),
      ),
    ).toHaveLength(2);
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.path === '/api/sites',
      ),
    ).toHaveLength(0);
  });

  test('ls --all prints the public directory whatever the directory is', async () => {
    process.chdir(site());
    await deploy('.', { name: 'notes' });

    const printed = await capture(() => ls('.', { all: true }));
    expect(printed).toContain('notes');
    expect(printed).toContain('v3');
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.path === '/api/sites',
      ),
    ).toHaveLength(1);
  });

  test('refuses a kthx.json that names something no site can be called', async () => {
    // The file is committed and cloned; the string in it becomes a host to open
    // and a path to call, so it is checked before either is built.
    for (const [name, code] of [
      ['evil.example/#', 'INVALID_NAME'],
      ['ab', 'INVALID_NAME'],
      ['api', 'RESERVED'],
    ] as const) {
      const dir = site({ 'kthx.json': JSON.stringify({ name }) });
      process.chdir(dir);
      expect(() => openSite('.')).toThrowError(
        expect.objectContaining({ code }),
      );
      await expect(ls('.')).rejects.toMatchObject({ code });
    }
  });
});

describe('siteOrigin', () => {
  test('is the apex with the name as a label in front of it', () => {
    process.env.KTHX_ORIGIN = 'https://kthx.dev';
    expect(siteOrigin('notes')).toBe('https://notes.kthx.dev');
    process.env.KTHX_ORIGIN = 'http://127.0.0.1:8080/';
    expect(siteOrigin('notes')).toBe('http://notes.127.0.0.1:8080');
  });
});
