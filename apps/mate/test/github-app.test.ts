/**
 * The GitHub App credential. A real `Bun.serve` stands in for GitHub, so the
 * assertions read the JWT and the mint body as GitHub would.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import type { Server } from 'bun';
import {
  GIT_HTTPS_USERNAME,
  GithubApp,
  GithubAppError,
  type GithubAppOptions,
} from '../src/github-app.ts';
import { FakeClock, RecordingLog } from './support.ts';

const HOUR_MS = 60 * 60_000;
/** The default turn cap; the reuse floor adds five minutes to it. */
const TURN_TIMEOUT_MS = 45 * 60_000;

/** Generated once: a 2048-bit keygen is slow. */
let privateKey = '';
let publicKey = '';

beforeAll(() => {
  // PKCS#1: the shape GitHub's key download has, and WebCrypto refuses.
  const pair = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

interface Call {
  method: string;
  path: string;
  bearer: string;
  body: string;
}

class FakeGitHub {
  readonly calls: Call[] = [];
  private readonly server: Server<never>;
  /** The ids discovery hands out, in order; the last one repeats. */
  installationIds = [42];
  /** Installations whose mint answers 404, as an uninstalled App does. */
  readonly gone = new Set<number>();
  slug = 'clanky-bot';
  minted = 0;
  revoked: string[] = [];
  /** Never answers. */
  hang = false;
  /** Refuses everything with this status and a body, as a revoked App does. */
  denyWith: number | null = null;

  constructor(private readonly clock: FakeClock) {
    const fake = this;
    this.server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 60,
      async fetch(request) {
        const url = new URL(request.url);
        fake.calls.push({
          method: request.method,
          path: url.pathname,
          bearer: (request.headers.get('authorization') ?? '').replace(
            /^Bearer /,
            '',
          ),
          body: await request.text(),
        });
        if (fake.hang) return new Promise<Response>(() => {});
        return fake.answer(request.method, url.pathname);
      },
    });
  }

  private answer(method: string, path: string): Response {
    if (this.denyWith !== null) {
      return Response.json(
        { message: 'Bad credentials' },
        {
          status: this.denyWith,
          headers: { 'x-github-request-id': 'ABCD:1234' },
        },
      );
    }
    if (path.endsWith('/installation') && method === 'GET') {
      const id =
        this.installationIds.length > 1
          ? (this.installationIds.shift() as number)
          : (this.installationIds[0] as number);
      return Response.json({ id, app_slug: this.slug });
    }
    const mint = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (mint && method === 'POST') {
      const id = Number(mint[1]);
      if (this.gone.has(id)) {
        return Response.json({ message: 'Not Found' }, { status: 404 });
      }
      this.minted += 1;
      return Response.json({
        token: `ghs_token_${this.minted}`,
        expires_at: new Date(this.clock.now() + HOUR_MS).toISOString(),
      });
    }
    if (path === '/installation/token' && method === 'DELETE') {
      this.revoked.push(this.calls[this.calls.length - 1]?.bearer ?? '');
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: 'nope' }, { status: 418 });
  }

  get base(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  of(path: string): Call[] {
    return this.calls.filter((call) => call.path === path);
  }

  stop(): void {
    this.server.stop(true);
  }
}

interface Harness {
  app: GithubApp;
  github: FakeGitHub;
  clock: FakeClock;
  log: RecordingLog;
}

function build(overrides: Partial<GithubAppOptions> = {}): Harness {
  const clock = new FakeClock();
  const log = new RecordingLog();
  const github = new FakeGitHub(clock);
  const app = new GithubApp({
    appId: '5027196',
    privateKey,
    owner: 'jonpulsifer',
    repo: 'infra',
    turnTimeoutMs: TURN_TIMEOUT_MS,
    clock,
    log,
    apiBase: github.base,
    ...overrides,
  });
  return { app, github, clock, log };
}

interface Jwt {
  header: { alg?: string; typ?: string };
  claims: { iat?: number; exp?: number; iss?: string };
  signed: string;
  signature: string;
}

function decodeJwt(value: string): Jwt {
  const [header = '', claims = '', signature = ''] = value.split('.');
  const json = (part: string) =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  return {
    header: json(header),
    claims: json(claims),
    signed: `${header}.${claims}`,
    signature,
  };
}

describe('the App JWT', () => {
  test('is RS256 over a PKCS#1 key, backdated a minute and good for nine', async () => {
    const { app, github, clock } = build();
    try {
      await app.token();
      const jwt = decodeJwt(
        github.of('/repos/jonpulsifer/infra/installation')[0]?.bearer as string,
      );
      expect(jwt.header.alg).toBe('RS256');
      expect(jwt.header.typ).toBe('JWT');
      const now = Math.floor(clock.now() / 1000);
      // GitHub refuses a JWT issued in its future or living past ten minutes.
      expect(jwt.claims.iat).toBe(now - 60);
      expect(jwt.claims.exp).toBe(now + 540);
      expect(jwt.claims.exp).toBeLessThan(now + 600);
      expect(jwt.claims.iss).toBe('5027196');
      // A key that loaded but signed wrongly passes every check above.
      const verifier = createVerify('RSA-SHA256');
      verifier.update(jwt.signed);
      expect(verifier.verify(publicKey, jwt.signature, 'base64url')).toBe(true);
    } finally {
      github.stop();
    }
  });

  test('a key that is not a key fails at construction, without quoting it', () => {
    const clock = new FakeClock();
    let thrown: unknown;
    try {
      new GithubApp({
        appId: '5027196',
        privateKey: '-----BEGIN RSA PRIVATE KEY-----\nnope\n',
        owner: 'jonpulsifer',
        repo: 'infra',
        turnTimeoutMs: TURN_TIMEOUT_MS,
        clock,
        log: new RecordingLog(),
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GithubAppError);
    expect((thrown as GithubAppError).message).not.toContain('nope');
  });
});

describe('a mint', () => {
  test('narrows the token to this repo and these permissions every time', async () => {
    const { app, github } = build();
    try {
      await app.token();
      const [call] = github.of('/app/installations/42/access_tokens');
      expect(call?.method).toBe('POST');
      const body = JSON.parse(call?.body ?? '{}');
      // Scoped at the mint, so widening the installation never widens a sandbox's token.
      expect(body).toEqual({
        repositories: ['infra'],
        permissions: {
          contents: 'write',
          pull_requests: 'write',
          actions: 'read',
        },
      });
    } finally {
      github.stop();
    }
  });

  test('discovers the installation once and reuses the id', async () => {
    const { app, github } = build();
    try {
      await app.token();
      await app.preflight();
      expect(github.of('/repos/jonpulsifer/infra/installation')).toHaveLength(
        1,
      );
      expect(github.minted).toBe(2);
      expect(app.login).toBe('clanky-bot[bot]');
    } finally {
      github.stop();
    }
  });

  test('rediscovers once when the installation is gone, then gives up', async () => {
    const { app, github } = build();
    try {
      github.installationIds = [42, 43];
      github.gone.add(42);
      const token = await app.token();
      expect(token.token).toBe('ghs_token_1');
      expect(github.of('/repos/jonpulsifer/infra/installation')).toHaveLength(
        2,
      );
      expect(github.of('/app/installations/43/access_tokens')).toHaveLength(1);

      github.gone.add(43);
      await expect(app.preflight()).rejects.toMatchObject({
        name: 'GithubAppError',
        status: 404,
      });
    } finally {
      github.stop();
    }
  });
});

describe('the reuse rule', () => {
  test('holds a token only while a whole turn plus five minutes fits in it', async () => {
    const { app, github, clock } = build();
    try {
      const first = await app.token();
      expect(github.minted).toBe(1);

      // Nine minutes in, 51 of the 60 are left against a floor of 50.
      await clock.advance(9 * 60_000);
      expect((await app.token()).token).toBe(first.token);
      expect(github.minted).toBe(1);

      // Eleven minutes in, 49 are left: under the floor.
      await clock.advance(2 * 60_000);
      const second = await app.token();
      expect(second.token).not.toBe(first.token);
      expect(github.minted).toBe(2);
      expect(second.expiresAt - clock.now()).toBe(HOUR_MS);
    } finally {
      github.stop();
    }
  });
});

describe('a revoke', () => {
  test('spends the token on its own deletion and drops it from the cache', async () => {
    const { app, github } = build();
    try {
      const token = await app.token();
      await app.revoke(token.token);
      // Authenticated with the token itself: nothing else can revoke one.
      expect(github.revoked).toEqual([token.token]);
      expect((await app.token()).token).not.toBe(token.token);
      expect(github.minted).toBe(2);
    } finally {
      github.stop();
    }
  });
});

describe('every call', () => {
  test('is bounded, so a GitHub that never answers fails a turn instead of holding it', async () => {
    const { app, github } = build({ timeoutMs: 100 });
    try {
      github.hang = true;
      // Bun's fetch has no default deadline, so an unbounded call hangs the turn.
      await expect(app.token()).rejects.toMatchObject({
        name: 'GithubAppError',
        status: 0,
      });
    } finally {
      github.stop();
    }
  });

  test('carries the status and the request id, never the body', async () => {
    const { app, github } = build();
    try {
      github.denyWith = 401;
      const failure = await app.token().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GithubAppError);
      expect((failure as GithubAppError).status).toBe(401);
      // Keep the request id for support; drop the body, which could echo a token.
      expect((failure as GithubAppError).message).toContain('ABCD:1234');
      expect((failure as GithubAppError).message).not.toContain(
        'Bad credentials',
      );
    } finally {
      github.stop();
    }
  });
});

describe('the log', () => {
  test('never carries the token or the key', async () => {
    const { app, github, log } = build();
    try {
      const token = await app.token();
      await app.preflight();
      const written = JSON.stringify(log.entries);
      expect(written).not.toContain(token.token);
      expect(written).not.toContain('PRIVATE KEY');
    } finally {
      github.stop();
    }
  });

  // The caller logs readiness, so a line from here would duplicate it.
  test('a preflight reports its answer and says nothing itself', async () => {
    const { app, github, log } = build();
    try {
      const status = await app.preflight();
      expect(status.login).toBe('clanky-bot[bot]');
      expect(status.installationId).toBe(42);
      expect(log.of('github app ready')).toHaveLength(0);
    } finally {
      github.stop();
    }
  });
});

test('git is handed the constant username an installation token wants', () => {
  expect(GIT_HTTPS_USERNAME).toBe('x-access-token');
});
