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
import { forgetIdentity } from '../cli/identity.ts';
import {
  adopt,
  deploy,
  init,
  KthxError,
  ls,
  openSite,
  release,
  rm,
  rollback,
  siteOrigin,
  sitesFile,
  whoami,
} from '../cli/main.ts';

/** The ID token the CLI is told to send, and the address the stub reads off it. */
const IDENTITY = 'stub.identity.token';
const OWNER = 'operator@example.com';

interface Upload {
  readonly name: string;
  readonly bearer: string | null;
  readonly filename: string | null;
  readonly paths: string[];
}

const NAME = /^[a-z]+-[a-z]+-\d\d$/;
const calls: { method: string; path: string; body: unknown }[] = [];
const uploads: Upload[] = [];
/** Names this identity owns. */
const owned = new Set<string>();
/** Names still carrying a pre-identity bearer, which is what `adopt` spends. */
const tokens = new Map<string, string>();
const deleted: string[] = [];
let n = 0;
/** How many claims to answer TAKEN before accepting one. */
let refuseClaims = 0;

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
    const bearer = request.headers.get('authorization')?.slice(7) ?? null;
    const who = bearer === IDENTITY ? OWNER : null;
    const unauthenticated = Response.json(
      { code: 'UNAUTHENTICATED', message: 'this needs a google identity' },
      { status: 401 },
    );
    if (pathname === '/api/whoami') {
      calls.push({ method: 'GET', path: pathname, body: null });
      return who === null ? unauthenticated : Response.json({ email: who });
    }
    if (request.method === 'GET' && pathname === '/api/sites') {
      calls.push({ method: 'GET', path: pathname, body: null });
      const listed = [
        ...[...owned].map((claimed) => [claimed, OWNER] as const),
        ...[...tokens.keys()].map((claimed) => [claimed, null] as const),
      ];
      return Response.json({
        items: listed.map(([claimed, owner]) => ({
          name: claimed,
          url: `https://${claimed}.kthx.test`,
          owner,
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
      if (who === null) return unauthenticated;
      if (refuseClaims-- > 0 || owned.has(body.name) || body.name === 'taken') {
        return Response.json(
          { code: 'TAKEN', message: `${body.name} is taken` },
          { status: 409 },
        );
      }
      owned.add(body.name);
      // No token: the account that claimed the name is what opens it.
      return Response.json(
        { name: body.name, url: `https://${body.name}.kthx.test` },
        { status: 201 },
      );
    }
    if (name !== undefined && act === 'adopt' && request.method === 'POST') {
      const body = (await request.json()) as { token?: string };
      calls.push({ method: 'POST', path: pathname, body });
      if (who === null) return unauthenticated;
      if (tokens.get(name) !== body.token) {
        return Response.json(
          { code: 'FORBIDDEN', message: 'that does not open this site' },
          { status: 403 },
        );
      }
      tokens.delete(name);
      owned.add(name);
      return new Response(null, { status: 204 });
    }
    if (name === undefined || who === null || !owned.has(name)) {
      return Response.json(
        { code: 'FORBIDDEN', message: 'that does not open this site' },
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
        owner: OWNER,
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
  // The one thing standing in for `gcloud auth print-identity-token`; the
  // shell-out itself has its own tests below.
  process.env.KTHX_IDENTITY_TOKEN = IDENTITY;
  forgetIdentity();
  calls.length = 0;
  uploads.length = 0;
  deleted.length = 0;
  owned.clear();
  tokens.clear();
  n = 0;
  refuseClaims = 0;
  skillDown = false;
});
// Every command writes `kthx.json` relative to where it runs, so no test may
// leave the process standing somewhere else.
afterEach(() => process.chdir(cwd));

describe('deploy', () => {
  test('mints a name, writes down no token, and uploads the tar', async () => {
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

    // A claim mints nothing to store: the account is the credential.
    expect(() => statSync(sitesFile())).toThrow();

    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.filename).toBe('site.tar.gz');
    expect(uploads[0]!.paths).toEqual(['/app.js', '/index.html']);

    // The second deploy reuses the name and claims nothing.
    const second = await deploy('.');
    expect(second.n).toBe(2);
    expect(
      calls.filter(
        (call) => call.method === 'POST' && call.path === '/api/sites',
      ),
    ).toHaveLength(1);
    expect(uploads[1]!.bearer).toBe(IDENTITY);
  });

  test('rolls the dice again when a minted name is taken', async () => {
    refuseClaims = 1;
    const dir = site();
    process.chdir(dir);
    await deploy('.');
    const claims = calls.filter(
      (call) => call.method === 'POST' && call.path === '/api/sites',
    );
    expect(claims).toHaveLength(2);
    expect(claims[0]!.body).not.toEqual(claims[1]!.body);
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual(
      claims[1]!.body,
    );
  });

  test('--name claims that name, and refuses to rename or re-take one', async () => {
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

    // A name is a claim on the apex, not a note on this machine: asking for
    // one that is already claimed is refused, ours or not.
    const again = site();
    process.chdir(again);
    await expect(deploy('.', { name: 'notes' })).rejects.toMatchObject({
      code: 'TAKEN',
    });
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

  test("fails with the server's code, on a site that is not ours", async () => {
    const dir = site({ 'readme.md': 'no index' });
    process.chdir(dir);
    const error = await deploy('.').catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(KthxError);
    expect((error as KthxError).code).toBe('NO_INDEX');

    // A `kthx.json` naming somebody else's site is a 403 now, not a missing
    // note on this machine: the credential is the same one either way.
    const orphan = site();
    writeFileSync(join(orphan, 'kthx.json'), '{"name":"lost"}');
    process.chdir(orphan);
    await expect(deploy('.')).rejects.toMatchObject({ code: 'FORBIDDEN' });
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

    await rm('.', () => 'notes');
    expect(deleted).toEqual(['notes']);
  });

  test('every command but init, deploy and dev needs a name', async () => {
    const dir = site();
    process.chdir(dir);
    for (const command of [rollback, release]) {
      await expect(command('.')).rejects.toMatchObject({ code: 'NO_NAME' });
    }
  });

  test('ls with no kthx.json lists what this account owns', async () => {
    process.chdir(site());
    await deploy('.', { name: 'notes' });
    process.chdir(site());
    await deploy('.', { name: 'other' });
    // A name somebody else still holds with a bearer: in the directory, and
    // not in this listing.
    tokens.set('theirs', 'tok-theirs');
    // A directory that is not a site: the question is "which did I claim?",
    // and the directory carries the answer now.
    process.chdir(site());

    const printed = await capture(() => ls('.'));
    expect(printed).toContain(OWNER);
    expect(printed).toContain('notes');
    expect(printed).toContain('other');
    expect(printed).not.toContain('theirs');
    // One walk of the directory, and not one request per name.
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.path === '/api/sites',
      ),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) => call.method === 'GET' && call.path.startsWith('/api/sites/'),
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

/** `sites.json` as a machine that claimed before identities would have it. */
function storeToken(name: string, token: string): void {
  mkdirSync(join(sitesFile(), '..'), { recursive: true, mode: 0o700 });
  writeFileSync(
    sitesFile(),
    JSON.stringify({ [stub.url.origin]: { [name]: token } }),
  );
}

describe('identity', () => {
  test('whoami is the address the apex verified', async () => {
    expect(await capture(() => whoami())).toContain(OWNER);
  });

  test('adopt spends the old bearer and forgets it', async () => {
    const dir = site();
    writeFileSync(join(dir, 'kthx.json'), '{"name":"legacy"}');
    process.chdir(dir);
    // A site claimed before identities: a bearer on the apex, and the same
    // string in this machine's store.
    tokens.set('legacy', 'tok-legacy');
    storeToken('legacy', 'tok-legacy');

    // Until it is adopted, the identity opens nothing on it.
    await expect(ls('.')).rejects.toMatchObject({ code: 'FORBIDDEN' });

    await adopt('.');
    expect(owned.has('legacy')).toBe(true);
    // The string is spent on both sides: the apex dropped it, and so did this.
    expect(tokens.has('legacy')).toBe(false);
    expect(
      JSON.parse(readFileSync(sitesFile(), 'utf8'))[stub.url.origin],
    ).toEqual({});

    const found = await ls('.');
    expect(found?.owner).toBe(OWNER);
  });

  test('adopt with no stored bearer says so rather than asking', async () => {
    const dir = site();
    writeFileSync(join(dir, 'kthx.json'), '{"name":"notes"}');
    process.chdir(dir);
    await expect(adopt('.')).rejects.toMatchObject({ code: 'NO_TOKEN' });
    expect(calls.filter((call) => call.path.endsWith('/adopt'))).toHaveLength(
      0,
    );
  });

  test('a wrong bearer adopts nothing', async () => {
    const dir = site();
    writeFileSync(join(dir, 'kthx.json'), '{"name":"legacy"}');
    process.chdir(dir);
    tokens.set('legacy', 'tok-legacy');
    storeToken('legacy', 'not-the-token');
    await expect(adopt('.')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(owned.has('legacy')).toBe(false);
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
