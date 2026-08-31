/**
 * The client against a `Bun.serve` that speaks the contract: what it sends,
 * what it writes down, and how it fails.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
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
  KthxError,
  release,
  rollback,
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
let n = 0;
/** How many claims to answer TAKEN before accepting one. */
let refuseClaims = 0;

const stub = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const [, , , name, act] = pathname.split('/');
    if (request.method === 'POST' && pathname === '/kthx/sites') {
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
          digest: 'sha256:abc',
          url: `https://${name}.kthx.test`,
          serving: n,
        },
        { status: 201 },
      );
    }
    const body = request.method === 'POST' ? await request.json() : null;
    calls.push({ method: request.method, path: pathname, body });
    if (request.method === 'GET' && act === undefined) {
      return Response.json({
        name,
        serving: 3,
        held: false,
        releases: [{ n: 3 }, { n: 2 }, { n: 1 }],
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

beforeEach(() => {
  process.env.KTHX_ORIGIN = `${stub.url.origin}/`;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kthx-config-'));
  calls.length = 0;
  uploads.length = 0;
  tokens.clear();
  n = 0;
  refuseClaims = 0;
});

describe('deploy', () => {
  test('mints a name, keeps the token out of the directory, and uploads the tar', async () => {
    const dir = site({
      'index.html': '<h1>hi</h1>',
      'app.js': 'x',
      '.env': 'SECRET',
      'node_modules/x.js': 'x',
    });
    const first = await deploy(dir);
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
    const second = await deploy(dir);
    expect(second.n).toBe(2);
    expect(calls.filter((call) => call.path === '/kthx/sites')).toHaveLength(1);
    expect(uploads[1]!.bearer).toBe(`tok-${name}`);
  });

  test('rolls the dice again when a minted name is taken', async () => {
    refuseClaims = 1;
    const dir = site();
    await deploy(dir);
    const claims = calls.filter((call) => call.path === '/kthx/sites');
    expect(claims).toHaveLength(2);
    expect(claims[0]!.body).not.toEqual(claims[1]!.body);
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual(
      claims[1]!.body,
    );
  });

  test('--name claims that name, and does not retry when it is taken', async () => {
    const dir = site();
    await deploy(dir, { name: 'notes' });
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual({
      name: 'notes',
    });
    const other = site();
    await expect(deploy(other, { name: 'taken' })).rejects.toMatchObject({
      code: 'TAKEN',
    });
    expect(calls.filter((call) => call.path === '/kthx/sites')).toHaveLength(2);
    await expect(deploy(dir, { name: 'other' })).rejects.toMatchObject({
      code: 'NAMED',
    });
  });

  test("fails with the server's code, and without a token", async () => {
    const dir = site({ 'readme.md': 'no index' });
    const error = await deploy(dir).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(KthxError);
    expect((error as KthxError).code).toBe('NO_INDEX');

    const orphan = site();
    writeFileSync(join(orphan, 'kthx.json'), '{"name":"lost"}');
    await expect(deploy(orphan)).rejects.toMatchObject({ code: 'NO_TOKEN' });
  });
});

describe('rollback and release', () => {
  test('serve the release before the serving one, or the one named, then unhold', async () => {
    const dir = site();
    await deploy(dir, { name: 'notes' });
    expect(await rollback(dir)).toBe(2);
    expect(await rollback(dir, 1)).toBe(1);
    expect(await release(dir)).toBe(3);
    expect(
      calls.filter((call) => call.path.startsWith('/kthx/sites/notes')),
    ).toEqual([
      { method: 'GET', path: '/kthx/sites/notes', body: null },
      { method: 'POST', path: '/kthx/sites/notes/serve', body: { n: 2 } },
      { method: 'GET', path: '/kthx/sites/notes', body: null },
      { method: 'POST', path: '/kthx/sites/notes/serve', body: { n: 1 } },
      { method: 'DELETE', path: '/kthx/sites/notes/hold', body: null },
    ]);
  });
});
