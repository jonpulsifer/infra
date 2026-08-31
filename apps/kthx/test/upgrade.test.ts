/**
 * The three things that make the CLI fun and have to stay harmless: colour, the
 * once-a-day update check, and `kthx upgrade`.
 *
 * The check is the one with teeth. It runs beside every command, so most of
 * what is asserted here is the same claim from different angles — it cannot
 * outlast its cap, cannot change what the command prints, and cannot change
 * what it exits with.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { forgetIdentity, identityToken } from '../cli/identity.ts';
import { level, rainbow, tint } from '../cli/paint.ts';
import { updateNudge, upgrade } from '../cli/upgrade.ts';

const APP = join(import.meta.dir, '..');
const CLI = join(APP, 'cli', 'main.ts');

/** stdout claiming to be a terminal for the length of one call. */
function asTty<T>(run: () => T): T {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = true;
  try {
    return run();
  } finally {
    process.stdout.isTTY = was;
  }
}

/** stdout claiming to be a pipe, whatever the test runner is attached to. */
function asPipe<T>(run: () => T): T {
  const was = process.stdout.isTTY;
  process.stdout.isTTY = false;
  try {
    return run();
  } finally {
    process.stdout.isTTY = was;
  }
}

/** `env` in place for the length of one call, and exactly those keys restored. */
function withEnv<T>(env: Record<string, string | undefined>, run: () => T): T {
  const was = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  const put = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  put(env);
  try {
    return run();
  } finally {
    put(was);
  }
}

describe('paint', () => {
  test('emits nothing at all when stdout is not a terminal', () => {
    asPipe(() => {
      expect(level()).toBe(0);
      expect(rainbow('kthx')).toBe('kthx');
      expect(tint('kthx', 0.5)).toBe('kthx');
    });
  });

  test('NO_COLOR and TERM=dumb beat a terminal', () => {
    asTty(() => {
      withEnv({ NO_COLOR: '1', TERM: 'xterm-256color' }, () => {
        expect(rainbow('kthx')).toBe('kthx');
      });
      withEnv({ NO_COLOR: undefined, TERM: 'dumb' }, () => {
        expect(rainbow('kthx')).toBe('kthx');
      });
    });
  });

  test('truecolor when the terminal says so, the 256 cube when it does not', () => {
    asTty(() => {
      withEnv(
        { NO_COLOR: undefined, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        () => {
          expect(level()).toBe(2);
          const painted = rainbow('kthx');
          expect(painted).toContain('\x1b[38;2;255;45;155m');
          expect(painted.endsWith('\x1b[0m')).toBe(true);
          expect(painted).not.toContain('38;5;');
        },
      );
      withEnv(
        { NO_COLOR: undefined, TERM: 'xterm-256color', COLORTERM: undefined },
        () => {
          expect(level()).toBe(1);
          const painted = rainbow('kthx');
          expect(painted).toContain('\x1b[38;5;');
          expect(painted).not.toContain('38;2;');
        },
      );
    });
  });

  test('the ramp runs left to right, ending where the landing page does', () => {
    asTty(() => {
      withEnv(
        { NO_COLOR: undefined, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        () => {
          const codes = [
            ...rainbow('k'.repeat(24)).matchAll(/38;2;[\d;]+/g),
          ].map((found) => found[0]);
          expect(codes.length).toBeGreaterThan(4);
          expect(codes[0]).toBe('38;2;255;45;155');
          expect(codes.at(-1)).toBe('38;2;91;168;0');
        },
      );
    });
  });
});

// --- the update check -------------------------------------------------------

/** An apex that accepts the connection and never answers it. */
const silent = Bun.serve({
  port: 0,
  fetch: () => new Promise<Response>(() => {}),
});

/** An apex that answers a build id, and counts how often it is asked. */
let asked = 0;
const talkative = Bun.serve({
  port: 0,
  fetch: () => {
    asked += 1;
    return new Response(null, {
      headers: { 'x-kthx-build': '9.9.9+ffffffffffff' },
    });
  },
});

afterAll(() => {
  silent.stop(true);
  talkative.stop(true);
});

const MINE = '2.0.0+000000000000';
let config = '';

beforeEach(() => {
  config = mkdtempSync(join(tmpdir(), 'kthx-update-'));
  process.env.XDG_CONFIG_HOME = config;
  delete process.env.KTHX_NO_UPDATE_CHECK;
  asked = 0;
});

const cache = () => join(config, 'kthx', 'update.json');

const ask = (over: Partial<Parameters<typeof updateNudge>[0]> = {}) =>
  asTty(() =>
    updateNudge({
      origin: talkative.url.origin,
      mine: MINE,
      command: 'ls',
      versionAsked: false,
      ...over,
    }),
  );

describe('the update check', () => {
  test('one line when the apex has a different build, and it is remembered', async () => {
    await expect(ask()).resolves.toBe('  update available — kthx upgrade');
    expect(asked).toBe(1);
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toMatchObject({
      build: '9.9.9+ffffffffffff',
    });

    // Within the day the answer comes from the file, not the apex.
    await expect(ask()).resolves.toBe('  update available — kthx upgrade');
    expect(asked).toBe(1);
  });

  test('nothing to say when the builds match', async () => {
    await expect(ask({ mine: '9.9.9+ffffffffffff' })).resolves.toBeNull();
  });

  test('a cache older than a day is asked again', async () => {
    mkdirSync(join(config, 'kthx'), { recursive: true });
    writeFileSync(
      cache(),
      JSON.stringify({
        at: Date.now() - 25 * 60 * 60 * 1000,
        build: 'stale',
      }),
    );
    await expect(ask()).resolves.toBe('  update available — kthx upgrade');
    expect(asked).toBe(1);
  });

  test.each([
    ['upgrade', { command: 'upgrade' }, {}],
    ['--version', { versionAsked: true }, {}],
    ['a checkout with no build of its own', { mine: null }, {}],
    ['KTHX_NO_UPDATE_CHECK=1', {}, { KTHX_NO_UPDATE_CHECK: '1' }],
  ] as const)('asks nothing at all for %s', async (_what, over, env) => {
    const started = Date.now();
    await withEnv(env, () =>
      expect(ask({ origin: silent.url.origin, ...over })).resolves.toBeNull(),
    );
    expect(Date.now() - started).toBeLessThan(500);
    expect(asked).toBe(0);
    expect(existsSync(cache())).toBe(false);
  });

  test('says nothing when stdout is a pipe, whatever the apex says', async () => {
    await expect(
      asPipe(() =>
        updateNudge({
          origin: talkative.url.origin,
          mine: MINE,
          command: 'ls',
          versionAsked: false,
        }),
      ),
    ).resolves.toBeNull();
    expect(asked).toBe(0);
  });

  test('an apex that never answers costs the cap once a day, not once a command', async () => {
    // The measurement the check exists to bound: a connection accepted and
    // never answered. It has to end, near the 1.5 s cap, resolving `null`
    // rather than throwing — a rejection here would take the command with it.
    const started = Date.now();
    await expect(ask({ origin: silent.url.origin })).resolves.toBeNull();
    const took = Date.now() - started;
    expect(took).toBeGreaterThan(1000);
    expect(took).toBeLessThan(3000);

    // Silence is an answer and is remembered like one: a machine with no route
    // to the apex waits once, not on every command it types that day.
    expect(JSON.parse(readFileSync(cache(), 'utf8'))).toMatchObject({
      build: null,
    });
    const again = Date.now();
    await expect(ask({ origin: silent.url.origin })).resolves.toBeNull();
    expect(Date.now() - again).toBeLessThan(500);
  }, 10_000);
});

// --- the command line -------------------------------------------------------

describe('the CLI', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    Bun.spawn([process.execPath, CLI, ...args], {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: config,
        KTHX_ORIGIN: silent.url.origin,
        ...env,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });

  test('a bare kthx is the banner and the usage, on stdout, exit 0', async () => {
    const child = run([]);
    const [code, out] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(out).toContain('█');
    expect(out).toContain('usage: kthx');
    expect(out).toContain('upgrade');
    // Not a terminal: not one escape code, banner included.
    expect(out).not.toContain('\x1b');
  }, 30_000);

  test('an unknown command is still usage on stderr, exit 2', async () => {
    const child = run(['nope']);
    const [code, err] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(err).toContain('usage: kthx');
  }, 30_000);

  test('a command with no google login says how to get one, and fast', async () => {
    // No `gcloud` on this PATH and no token in the environment: the command
    // ends on the login, not on the network, so the silent apex costs it
    // nothing at all — over a pipe the update check is skipped outright.
    const bare = mkdtempSync(join(tmpdir(), 'kthx-nopath-'));
    const started = Date.now();
    const child = run(['ls'], { PATH: bare, KTHX_IDENTITY_TOKEN: '' });
    const [code, err] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(1);
    expect(err).toContain('NO_IDENTITY');
    expect(err).toContain('gcloud auth login');
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);
});

// --- the google identity ----------------------------------------------------

describe('the identity token', () => {
  /** A `gcloud` on PATH that prints what this test tells it to. */
  function stubGcloud(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'kthx-gcloud-'));
    writeFileSync(join(dir, 'gcloud'), `#!/bin/sh\n${script}\n`, {
      mode: 0o755,
    });
    return dir;
  }

  const was = process.env.PATH;
  beforeEach(() => {
    forgetIdentity();
    delete process.env.KTHX_IDENTITY_TOKEN;
  });
  afterAll(() => {
    process.env.PATH = was;
  });

  test('is what gcloud prints, minted once and kept until it expires', async () => {
    const minted = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    // Every call after the first appends to `count`, so a second mint shows up
    // as a second line rather than as a different token.
    const counted = mkdtempSync(join(tmpdir(), 'kthx-count-'));
    process.env.PATH = `${stubGcloud(
      `echo ran >> ${join(counted, 'count')}\nprintf %s ${minted}`,
    )}:${was}`;

    expect(await identityToken()).toBe(minted);
    expect(await identityToken()).toBe(minted);
    expect(readFileSync(join(counted, 'count'), 'utf8').trim()).toBe('ran');
  });

  test('is minted again once the old one is near its end', async () => {
    // A token already inside the early-mint window is not worth sending: the
    // next call must go back to gcloud rather than hand out something the
    // apex is about to refuse.
    const stale = jwt({ exp: Math.floor(Date.now() / 1000) + 5 });
    process.env.PATH = `${stubGcloud(`printf %s ${stale}`)}:${was}`;
    expect(await identityToken()).toBe(stale);
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    process.env.PATH = `${stubGcloud(`printf %s ${fresh}`)}:${was}`;
    expect(await identityToken()).toBe(fresh);
  });

  test('a gcloud that refuses is one error naming the login', async () => {
    process.env.PATH = `${stubGcloud(
      'echo "ERROR: Reauthentication failed" >&2\nexit 1',
    )}:${was}`;
    await expect(identityToken()).rejects.toMatchObject({
      code: 'NO_IDENTITY',
    });
    await expect(identityToken()).rejects.toThrow(/gcloud auth login/);
  });

  test('a gcloud that prints nothing is the same error', async () => {
    process.env.PATH = `${stubGcloud('exit 0')}:${was}`;
    await expect(identityToken()).rejects.toMatchObject({
      code: 'NO_IDENTITY',
    });
  });

  test('KTHX_IDENTITY_TOKEN is used verbatim, and gcloud is never asked', async () => {
    process.env.PATH = `${stubGcloud('exit 1')}:${was}`;
    process.env.KTHX_IDENTITY_TOKEN = 'from.the.environment';
    expect(await identityToken()).toBe('from.the.environment');
  });
});

/** A token shaped enough for the CLI to read an `exp` off it. */
function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(payload)}.signature`;
}

// --- upgrade ----------------------------------------------------------------

/** A tarball `bun add -g` installs, built around the packed bundle. */
function tarballOf(bundle: string, version: string, build: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kthx-tgz-'));
  writeFileSync(join(dir, 'kthx.js'), bundle);
  writeFileSync(
    join(dir, 'version.json'),
    `${JSON.stringify({ version, build, date: '2026-08-31' })}\n`,
  );
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({
      name: 'kthx',
      version,
      type: 'module',
      bin: { kthx: 'kthx.js' },
      files: ['kthx.js', 'version.json'],
    })}\n`,
  );
  return dir;
}

describe('kthx upgrade', () => {
  test('replaces an existing global install, and --version says so', async () => {
    // The install line the apex documents, end to end: a real `bun run pack`, a
    // real `bun add -g` into a `BUN_INSTALL` of its own, and the tarball the
    // apex serves put over the top of it.
    await Bun.$`bun run pack`.cwd(APP).quiet();
    const bundle = readFileSync(join(APP, 'dist', 'kthx.js'), 'utf8');
    const mine = JSON.parse(
      readFileSync(join(APP, 'dist', 'version.json'), 'utf8'),
    ) as { version: string; build: string };

    const home = mkdtempSync(join(tmpdir(), 'kthx-install-'));
    const env = {
      ...process.env,
      BUN_INSTALL: home,
      HOME: home,
      XDG_CONFIG_HOME: config,
      KTHX_NO_UPDATE_CHECK: '1',
    };
    const kthx = join(home, 'bin', 'kthx');
    const asks = (from: string) =>
      Bun.$`bun add -g ${join(from, 'kthx.tgz')}`.env(env).quiet();

    const old = tarballOf(bundle, '1.2.3', '0123456789ab');
    await Bun.$`bun pm pack --quiet --filename kthx.tgz`.cwd(old).quiet();
    await asks(old);
    const before = (
      await Bun.$`${kthx} --version`.env(env).quiet().text()
    ).trim();
    expect(before).toBe('1.2.3 · 0123456789ab');

    const served = await Bun.file(join(APP, 'dist', 'kthx.tgz')).arrayBuffer();
    const id = `${mine.version}+${mine.build}`;
    const apex = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(served, {
          headers: { 'content-type': 'application/gzip', 'x-kthx-build': id },
        }),
    });
    try {
      const upgraded = Bun.spawn([kthx, 'upgrade'], {
        env: { ...env, KTHX_ORIGIN: apex.url.origin },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [code, out] = await Promise.all([
        upgraded.exited,
        new Response(upgraded.stdout).text(),
      ]);
      expect(code).toBe(0);
      expect(out).toContain(`1.2.3+0123456789ab → ${id}`);
    } finally {
      apex.stop(true);
    }

    const after = (
      await Bun.$`${kthx} --version`.env(env).quiet().text()
    ).trim();
    expect(after).toBe(`${mine.version} · ${mine.build}`);
    expect(after).not.toBe(before);
  }, 180_000);

  test('a refusal from the apex is the apex code, not a stack', async () => {
    const gone = Bun.serve({
      port: 0,
      fetch: () =>
        Response.json(
          { code: 'NOT_FOUND', message: 'nothing here' },
          { status: 404 },
        ),
    });
    try {
      await expect(upgrade(gone.url.origin)).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    } finally {
      gone.stop(true);
    }
  });
});
