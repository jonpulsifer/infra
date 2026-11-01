/**
 * The CLI against a fake bucket and a stub apex: what it claims, uploads,
 * deletes and asks, and what it refuses.
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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlEncode } from '@repo/archive/bytes';
import { type FakeCall, fakeGcs } from '@repo/archive/fake-gcs';
import {
  deploy,
  forgetCredentials,
  type Io,
  init,
  ls,
  nuke,
  openSite,
  rm,
  siteUrl,
} from '../cli/main.ts';

const BUCKET = 'sites-under-test';
const ME = 'me@example.com';
const THEM = 'them@example.com';
const NAME = /^[a-z]+-[a-z]+-\d\d$/;
const SKILL = '# kthx\n\nthe apex copy\n';

const gcs = fakeGcs();

/** Who the stub token endpoint says the caller is. */
let email = ME;
/** Names `/api/names/:name` reports as held for a built app. */
const held = new Set<string>();
/** Requests to the stub apex, in order. */
const calls: { method: string; path: string; authorization: string | null }[] =
  [];
let nukeOpens = true;
let skillDown = false;

/** An unsigned ID token: the CLI reads it, the stub server never checks it. */
function idTokenFor(address: string): string {
  const part = (value: unknown) =>
    base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: 'none' })}.${part({ email: address, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

const stub = Bun.serve({
  port: 0,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    calls.push({
      method: request.method,
      path: pathname,
      authorization: request.headers.get('authorization'),
    });
    if (pathname === '/token') {
      return Response.json({
        access_token: `access-${email}`,
        id_token: idTokenFor(email),
        expires_in: 3600,
      });
    }
    if (pathname === '/skill.md') {
      return skillDown
        ? new Response(null, { status: 503 })
        : new Response(SKILL);
    }
    if (pathname === '/api') {
      return Response.json({ zone: 'kthx.test', url: 'https://kthx.test' });
    }
    const named = /^\/api\/names\/(.+)$/.exec(pathname)?.[1];
    if (named !== undefined) {
      const name = decodeURIComponent(named);
      if (name === 'admin') {
        return Response.json({ name, available: false, why: 'RESERVED' });
      }
      const taken = held.has(name) || gcs.get(BUCKET, `${name}/.kthx`);
      return Response.json({
        name,
        available: !taken,
        why: taken ? 'TAKEN' : null,
        yours: null,
      });
    }
    if (pathname === '/api/sites' && request.method === 'GET') {
      return Response.json({
        items: gcs
          .names(BUCKET)
          .filter((name) => name.endsWith('/.kthx'))
          .map((name) => ({
            name: name.slice(0, -6),
            url: `https://${name.slice(0, -6)}.kthx.test`,
            owner: null,
            deployed: '2026-11-01T00:00:00.000Z',
          })),
        next: null,
      });
    }
    if (pathname === '/api/sites' && request.method === 'DELETE') {
      return nukeOpens
        ? Response.json({ deleted: 2, failed: 0 })
        : Response.json(
            { code: 'NOT_FOUND', message: 'there is nothing here' },
            { status: 404 },
          );
    }
    const site = /^\/api\/sites\/([^/]+)$/.exec(pathname)?.[1];
    if (site !== undefined && request.method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    if (site !== undefined && request.method === 'GET') {
      return Response.json({
        usage: { db_bytes: 1024, files_bytes: 0 },
        quotas: { db_bytes: 268435456, files_bytes: 268435456 },
      });
    }
    return new Response(null, { status: 404 });
  },
});
afterAll(() => {
  stub.stop(true);
  gcs.stop();
});

function directory(
  files: Record<string, string> = { 'index.html': '<h1>hi</h1>' },
) {
  const dir = mkdtempSync(join(tmpdir(), 'kthx-site-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

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

/** A terminal that answers from a script, and records what it was asked. */
function answering(...answers: (string | null)[]): Io & { asked: string[] } {
  const asked: string[] = [];
  return {
    tty: true,
    asked,
    ask(question) {
      asked.push(question);
      return answers.shift() ?? null;
    },
  };
}

const noTerminal: Io = { tty: false, ask: () => null };

/** A site somebody already deployed, as their marker and one page. */
function theirs(name: string, owner = THEM) {
  gcs.put(BUCKET, `${name}/index.html`, '<h1>theirs</h1>');
  gcs.put(BUCKET, `${name}/.kthx`, '{}', {
    contentType: 'application/json',
    metadata: {
      'kthx-owner': owner,
      'kthx-deployed': '2026-10-31T12:34:56.000Z',
    },
  });
}

const writes = (from: number): FakeCall[] =>
  gcs.calls.slice(from).filter((call) => call.kind === 'write');
const deletes = (from: number): string[] =>
  gcs.calls
    .slice(from)
    .filter((call) => call.kind === 'delete')
    .map((call) => call.name);

const cwd = process.cwd();
beforeEach(() => {
  const config = mkdtempSync(join(tmpdir(), 'kthx-config-'));
  const adc = join(config, 'adc.json');
  writeFileSync(
    adc,
    JSON.stringify({
      type: 'authorized_user',
      client_id: 'id',
      client_secret: 'secret',
      refresh_token: 'refresh',
      token_uri: `${stub.url.origin}/token`,
    }),
  );
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adc;
  process.env.KTHX_ORIGIN = `${stub.url.origin}/`;
  process.env.KTHX_SITES_BUCKET = BUCKET;
  process.env.STORAGE_EMULATOR_HOST = gcs.url;
  process.env.XDG_CONFIG_HOME = config;
  gcs.buckets.delete(BUCKET);
  gcs.before = null;
  calls.length = 0;
  held.clear();
  email = ME;
  nukeOpens = true;
  skillDown = false;
  forgetCredentials();
});
// Commands write `kthx.json` relative to the working directory.
afterEach(() => process.chdir(cwd));

describe('deploy', () => {
  test('mints and claims a name, then uploads every file but the excluded', async () => {
    const dir = directory({
      'index.html': '<h1>hi</h1>',
      'app.js': 'x',
      'img/logo.svg': '<svg/>',
      '.env': 'SECRET',
      'node_modules/x.js': 'x',
    });
    process.chdir(dir);
    const from = gcs.calls.length;
    const result = await deploy('.', {}, noTerminal);
    const { name } = JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'));
    expect(name).toMatch(NAME);
    expect(result.url).toBe(`https://${name}.kthx.test`);
    expect(gcs.names(BUCKET, `${name}/`)).toEqual([
      `${name}/.kthx`,
      `${name}/app.js`,
      `${name}/img/logo.svg`,
      `${name}/index.html`,
    ]);

    // The claim is a marker written only if absent, and the deploy's last
    // write rewrites it against the generation the claim made.
    const markers = writes(from).filter(
      (call) => call.name === `${name}/.kthx`,
    );
    expect(markers.map((call) => call.ifGenerationMatch)).toEqual([
      '0',
      expect.stringMatching(/^\d+$/),
    ]);
    expect(writes(from).at(-1)?.name).toBe(`${name}/.kthx`);

    const marker = gcs.get(BUCKET, `${name}/.kthx`);
    expect(marker?.metadata['kthx-owner']).toBe(ME);
    expect(marker?.metadata['kthx-deployed']).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(marker?.contentType).toBe('application/json');
    expect(new TextDecoder().decode(marker?.bytes)).toBe('{}');

    const page = gcs.get(BUCKET, `${name}/index.html`);
    expect(page?.contentType).toBe('text/html; charset=utf-8');
    expect(page?.cacheControl).toBe('no-cache');
    expect(gcs.get(BUCKET, `${name}/img/logo.svg`)?.contentType).toBe(
      'image/svg+xml',
    );
  });

  test('uploads HTML last, and only what changed', async () => {
    const dir = directory({
      'index.html': '<h1>one</h1>',
      'about.html': 'about',
      'app.js': 'one',
      'style.css': 'h1{}',
    });
    process.chdir(dir);
    await deploy('.', { name: 'rsync-me' }, noTerminal);

    writeFileSync(join(dir, 'index.html'), '<h1>two</h1>');
    writeFileSync(join(dir, 'app.js'), 'two');
    const from = gcs.calls.length;
    const second = await deploy('.', {}, noTerminal);
    expect(second.uploaded).toEqual(['app.js', 'index.html']);
    expect(second.unchanged).toBe(2);
    expect(writes(from).map((call) => call.name)).toEqual([
      'rsync-me/app.js',
      'rsync-me/index.html',
      'rsync-me/.kthx',
    ]);
    expect(gcs.text(BUCKET, 'rsync-me/index.html')).toBe('<h1>two</h1>');

    // Every non-HTML upload of a first deploy precedes every HTML one.
    const fresh = directory({
      'b.html': 'b',
      'a.css': 'a',
      'index.html': 'i',
      'z.js': 'z',
      'deep/page.htm': 'p',
    });
    process.chdir(fresh);
    const start = gcs.calls.length;
    await deploy('.', { name: 'ordered' }, noTerminal);
    const order = writes(start)
      .map((call) => call.name)
      .filter((name) => !name.endsWith('/.kthx'));
    const firstHtml = order.findIndex((name) => /\.html?$/.test(name));
    expect(order.slice(0, firstHtml).every((n) => !/\.html?$/.test(n))).toBe(
      true,
    );
    expect(order.slice(firstHtml).every((n) => /\.html?$/.test(n))).toBe(true);
    expect(order).toHaveLength(5);
  });

  test('deletes what the directory no longer holds, after the uploads', async () => {
    const dir = directory({ 'index.html': 'i', 'old.js': 'o', 'keep.js': 'k' });
    process.chdir(dir);
    await deploy('.', { name: 'pruned' }, noTerminal);
    writeFileSync(join(dir, 'new.js'), 'n');
    Bun.spawnSync(['rm', join(dir, 'old.js')]);

    const from = gcs.calls.length;
    const result = await deploy('.', {}, noTerminal);
    expect(result.deleted).toEqual(['old.js']);
    expect(gcs.names(BUCKET, 'pruned/')).toEqual([
      'pruned/.kthx',
      'pruned/index.html',
      'pruned/keep.js',
      'pruned/new.js',
    ]);
    const order = gcs.calls
      .slice(from)
      .map((call) => `${call.kind} ${call.name}`);
    expect(order.indexOf('delete pruned/old.js')).toBeGreaterThan(
      order.indexOf('write pruned/new.js'),
    );
    expect(order.at(-1)).toBe('write pruned/.kthx');
  });

  test('a deploy that loses the marker race fails, and deletes nothing', async () => {
    const dir = directory({ 'index.html': 'mine', 'extra.js': 'e' });
    process.chdir(dir);
    await deploy('.', { name: 'raced' }, noTerminal);
    Bun.spawnSync(['rm', join(dir, 'extra.js')]);
    writeFileSync(join(dir, 'index.html'), 'mine again');

    // Somebody else's deploy lands while this one uploads.
    gcs.before = (call) => {
      if (call.kind === 'write' && call.name === 'raced/index.html') {
        gcs.before = null;
        theirs('raced');
      }
    };
    await expect(deploy('.', {}, noTerminal)).rejects.toMatchObject({
      code: 'RACED',
    });
    expect(gcs.names(BUCKET, 'raced/')).toContain('raced/extra.js');
    expect(gcs.get(BUCKET, 'raced/.kthx')?.metadata['kthx-owner']).toBe(THEM);
  });

  test('a marker rewritten after the last check still fails the deploy', async () => {
    const dir = directory({ 'index.html': 'one' });
    process.chdir(dir);
    await deploy('.', { name: 'late-race' }, noTerminal);
    writeFileSync(join(dir, 'index.html'), 'two');
    gcs.before = (call) => {
      if (
        call.kind === 'write' &&
        call.name === 'late-race/.kthx' &&
        call.ifGenerationMatch !== '0'
      ) {
        gcs.before = null;
        theirs('late-race');
      }
    };
    await expect(deploy('.', {}, noTerminal)).rejects.toMatchObject({
      code: 'RACED',
    });
    expect(gcs.get(BUCKET, 'late-race/.kthx')?.metadata['kthx-owner']).toBe(
      THEM,
    );
  });

  test('refuses a directory with no index page, and sends nothing', async () => {
    process.chdir(directory({ 'about.html': 'no index here' }));
    const from = gcs.calls.length;
    await expect(
      deploy('.', { name: 'empty' }, noTerminal),
    ).rejects.toMatchObject({ code: 'NO_INDEX' });
    expect(gcs.calls.length).toBe(from);
    expect(existsSync('kthx.json')).toBe(false);
  });

  test('refuses a dangling link rather than deploying a smaller site', async () => {
    const dir = directory();
    symlinkSync(join(dir, 'nowhere'), join(dir, 'broken.js'));
    process.chdir(dir);
    await expect(
      deploy('.', { name: 'linked' }, noTerminal),
    ).rejects.toMatchObject({ code: 'DANGLING_LINK' });
  });

  test('takes a lone top-level directory as the site', async () => {
    const dir = directory({ 'dist/index.html': 'built', 'dist/app.js': 'a' });
    process.chdir(dir);
    await deploy('.', { name: 'wrapped' }, noTerminal);
    expect(gcs.names(BUCKET, 'wrapped/')).toEqual([
      'wrapped/.kthx',
      'wrapped/app.js',
      'wrapped/index.html',
    ]);
  });

  test('deploys a subdirectory under the project root’s name', async () => {
    const root = directory({
      'kthx.json': JSON.stringify({ name: 'project' }),
      'dist/index.html': 'built',
    });
    process.chdir(root);
    await deploy('dist', {}, noTerminal);
    expect(gcs.text(BUCKET, 'project/index.html')).toBe('built');
  });

  test('a name held for a built app, or reserved, is refused', async () => {
    held.add('apps-name');
    process.chdir(directory());
    await expect(
      deploy('.', { name: 'apps-name' }, noTerminal),
    ).rejects.toMatchObject({ code: 'TAKEN' });
    process.chdir(directory());
    await expect(
      deploy('.', { name: 'admin' }, noTerminal),
    ).rejects.toMatchObject({ code: 'RESERVED' });
    expect(gcs.names(BUCKET)).toEqual([]);
  });
});

describe("somebody else's site", () => {
  const question =
    'site "shared" is owned by them@example.com (last deploy 2026-10-31 12:34 UTC). Overwrite? [y/N] ';

  test('asks before writing over it, and yes writes it as mine', async () => {
    theirs('shared');
    process.chdir(directory({ 'index.html': '<h1>mine</h1>' }));
    const io = answering('y');
    await deploy('.', { name: 'shared' }, io);
    expect(io.asked).toEqual([question]);
    expect(gcs.text(BUCKET, 'shared/index.html')).toBe('<h1>mine</h1>');
    expect(gcs.get(BUCKET, 'shared/.kthx')?.metadata['kthx-owner']).toBe(ME);
  });

  test('anything but yes leaves it alone', async () => {
    theirs('shared');
    process.chdir(directory({ 'index.html': '<h1>mine</h1>' }));
    const from = gcs.calls.length;
    await expect(
      deploy('.', { name: 'shared' }, answering('n')),
    ).rejects.toMatchObject({ code: 'DECLINED' });
    await expect(deploy('.', {}, answering(''))).rejects.toMatchObject({
      code: 'DECLINED',
    });
    expect(writes(from)).toEqual([]);
    expect(gcs.text(BUCKET, 'shared/index.html')).toBe('<h1>theirs</h1>');
  });

  test('with no terminal it refuses unless --force', async () => {
    theirs('shared');
    process.chdir(directory({ 'index.html': '<h1>mine</h1>' }));
    await expect(
      deploy('.', { name: 'shared' }, noTerminal),
    ).rejects.toMatchObject({ code: 'NOT_YOURS' });
    expect(gcs.text(BUCKET, 'shared/index.html')).toBe('<h1>theirs</h1>');

    await deploy('.', { force: true }, noTerminal);
    expect(gcs.text(BUCKET, 'shared/index.html')).toBe('<h1>mine</h1>');
    expect(gcs.get(BUCKET, 'shared/.kthx')?.metadata['kthx-owner']).toBe(ME);
  });

  test('a claim that loses the race is somebody else’s site, not mine', async () => {
    process.chdir(directory());
    // Their claim lands between the name check and this claim.
    gcs.before = (call) => {
      if (call.kind === 'write' && call.ifGenerationMatch === '0') {
        gcs.before = null;
        theirs('contested');
      }
    };
    await expect(
      deploy('.', { name: 'contested' }, noTerminal),
    ).rejects.toMatchObject({ code: 'NOT_YOURS' });
    expect(
      gcs.calls.some(
        (call) =>
          call.kind === 'write' &&
          call.name === 'contested/.kthx' &&
          call.ifGenerationMatch === '0',
      ),
    ).toBe(true);
    expect(gcs.get(BUCKET, 'contested/.kthx')?.metadata['kthx-owner']).toBe(
      THEM,
    );
  });

  test('init says whose a taken name is', async () => {
    theirs('wanted');
    const dir = directory({});
    await expect(init(dir, { name: 'wanted' })).rejects.toMatchObject({
      code: 'TAKEN',
      message: expect.stringContaining('them@example.com'),
    });
  });
});

describe('init', () => {
  test('claims, writes the apex reference, and starts an empty directory off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kthx-init-'));
    const name = await init(dir, {});
    expect(name).toMatch(NAME);
    expect(JSON.parse(readFileSync(join(dir, 'kthx.json'), 'utf8'))).toEqual({
      name,
    });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe(SKILL);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain(
      '/api/sdk.js',
    );
    expect(gcs.get(BUCKET, `${name}/.kthx`)?.metadata['kthx-owner']).toBe(ME);
    // A claim writes the marker and nothing else.
    expect(gcs.names(BUCKET, `${name}/`)).toEqual([`${name}/.kthx`]);
  });

  test('keeps a SKILL.md somebody wrote, and falls back when the apex is away', async () => {
    const dir = directory({ 'SKILL.md': 'mine' });
    await init(dir, { name: 'kept-skill' });
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf8')).toBe('mine');
    // A directory with files in it gets no starter page.
    expect(existsSync(join(dir, 'index.html'))).toBe(false);

    skillDown = true;
    const other = mkdtempSync(join(tmpdir(), 'kthx-init-'));
    await init(other, { name: 'bundled-skill' });
    expect(readFileSync(join(other, 'SKILL.md'), 'utf8')).not.toBe(SKILL);
  });

  test('a name already mine is mine to init again', async () => {
    theirs('again', ME);
    const dir = mkdtempSync(join(tmpdir(), 'kthx-init-'));
    expect(await init(dir, { name: 'again' })).toBe('again');
  });
});

describe('ls and rm', () => {
  test('ls reads the marker, and with no kthx.json lists only my sites', async () => {
    theirs('mine-one', ME);
    theirs('not-mine', THEM);
    process.chdir(
      directory({ 'kthx.json': JSON.stringify({ name: 'mine-one' }) }),
    );
    const one = await capture(() => ls('.'));
    expect(one).toContain('owned by me@example.com');
    expect(one).toContain('2026-10-31 12:34 UTC');
    expect(one).toContain('1.0 KB');
    const asked = calls.find((call) => call.path === '/api/sites/mine-one');
    expect(asked?.authorization).toBe(`Bearer ${idTokenFor(ME)}`);

    process.chdir(directory());
    const mine = await capture(() => ls('.'));
    expect(mine).toContain('mine-one');
    expect(mine).not.toContain('not-mine');

    const all = await capture(() => ls('.', { all: true }));
    expect(all).toContain('mine-one');
    expect(all).toContain('not-mine');
  });

  test('rm needs the name typed back, then frees the name, marker last', async () => {
    theirs('doomed', ME);
    gcs.put(BUCKET, 'doomed/app.js', 'a');
    process.chdir(
      directory({ 'kthx.json': JSON.stringify({ name: 'doomed' }) }),
    );

    await rm('.', {}, answering('nope'));
    expect(gcs.names(BUCKET, 'doomed/')).toHaveLength(3);

    const from = gcs.calls.length;
    await rm('.', {}, answering('doomed'));
    expect(gcs.names(BUCKET, 'doomed/')).toEqual([]);
    expect(deletes(from).at(-1)).toBe('doomed/.kthx');
    // The owner's site goes from the server too: its database and files.
    const server = calls.find(
      (call) => call.method === 'DELETE' && call.path === '/api/sites/doomed',
    );
    expect(server?.authorization).toBe(`Bearer ${idTokenFor(ME)}`);
  });

  test("rm asks before deleting somebody else's site", async () => {
    theirs('their-site', THEM);
    process.chdir(
      directory({ 'kthx.json': JSON.stringify({ name: 'their-site' }) }),
    );
    await expect(rm('.', {}, noTerminal)).rejects.toMatchObject({
      code: 'NOT_YOURS',
    });
    const io = answering('y', 'their-site');
    await rm('.', {}, io);
    expect(io.asked[0]).toContain('is owned by them@example.com');
    expect(io.asked[0]).toContain('Delete? [y/N]');
    expect(gcs.names(BUCKET, 'their-site/')).toEqual([]);
    // Not mine, so the server is not asked to delete it for me.
    expect(calls.some((call) => call.path === '/api/sites/their-site')).toBe(
      false,
    );
  });

  test('every command but init, deploy and dev needs a name', async () => {
    process.chdir(directory());
    await expect(rm('.', {}, noTerminal)).rejects.toMatchObject({
      code: 'NO_NAME',
    });
    await expect(openSite('.')).rejects.toMatchObject({ code: 'NO_NAME' });
  });

  test('refuses a kthx.json that names something no site can be called', async () => {
    for (const [name, code] of [
      ['evil.example/#', 'INVALID_NAME'],
      ['ab', 'INVALID_NAME'],
      ['api', 'RESERVED'],
    ] as const) {
      process.chdir(directory({ 'kthx.json': JSON.stringify({ name }) }));
      await expect(openSite('.')).rejects.toMatchObject({ code });
      await expect(ls('.')).rejects.toMatchObject({ code });
      await expect(deploy('.', {}, noTerminal)).rejects.toMatchObject({ code });
    }
  });
});

describe('nuke', () => {
  test('asks for NUKE, and carries no key of its own', async () => {
    const sent = () =>
      calls.filter(
        (call) => call.method === 'DELETE' && call.path === '/api/sites',
      );
    await nuke({}, () => 'nope');
    await nuke({}, () => null);
    expect(sent()).toHaveLength(0);

    const said = await capture(() => nuke({}, () => 'NUKE'));
    expect(said).toContain('2 deleted');
    expect(sent()).toHaveLength(1);
    expect(sent()[0]?.authorization).toBeNull();
  });

  test('against a host with no nuke says where one is', async () => {
    nukeOpens = false;
    await expect(nuke({ yes: true })).rejects.toMatchObject({
      code: 'NO_NUKE',
    });
  });
});

describe('credentials', () => {
  test('none at all says how to get some', async () => {
    process.env.GOOGLE_APPLICATION_CREDENTIALS = join(
      tmpdir(),
      'nothing-here.json',
    );
    forgetCredentials();
    process.chdir(directory());
    await expect(
      deploy('.', { name: 'nobody' }, noTerminal),
    ).rejects.toMatchObject({
      code: 'NO_CREDENTIALS',
      message: expect.stringContaining('gcloud auth application-default login'),
    });
  });

  test('the owner is whoever the credentials say', async () => {
    email = 'other@example.com';
    process.chdir(directory());
    await deploy('.', { name: 'whose' }, noTerminal);
    expect(gcs.get(BUCKET, 'whose/.kthx')?.metadata['kthx-owner']).toBe(
      'other@example.com',
    );
  });
});

describe('siteUrl', () => {
  test('is the zone the origin states with the name in front, whatever the origin is', async () => {
    expect(await siteUrl('notes')).toBe('https://notes.kthx.test');
  });
});
