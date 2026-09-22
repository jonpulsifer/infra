/**
 * The credential seam: what mate signs, what it asks GitHub for, how long it
 * is willing to hold the answer, and that neither the key nor the token ever
 * reaches a log line.
 *
 * The App is served by a `Bun.serve` of its own rather than a stubbed
 * `fetch`, so the assertions are about bytes on a wire — the JWT as GitHub
 * would parse it, the mint body as GitHub would read it.
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
/** The turn cap the reuse rule is written against. */
const TURN_TIMEOUT_MS = 45 * 60_000;

/** Made once: a 2048-bit keygen is the slowest thing in this file by far. */
let privateKey = '';
let publicKey = '';

beforeAll(() => {
  // PKCS#1 on purpose — `BEGIN RSA PRIVATE KEY` is the shape GitHub's own
  // download has, and the shape WebCrypto refuses. No key here is ever
  // committed: it lives for the length of the run.
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

/** Enough of api.github.com to answer an App, and to misbehave on demand. */
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
  /** Answers nothing at all, for the bounded-fetch case. */
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
      // Backdated against skew, and a minute inside GitHub's ten-minute cap:
      // a JWT issued in the apiserver's future is refused outright.
      expect(jwt.claims.iat).toBe(now - 60);
      expect(jwt.claims.exp).toBe(now + 540);
      expect(jwt.claims.exp).toBeLessThan(now + 600);
      expect(jwt.claims.iss).toBe('5027196');
      // The signature is the whole point of the PKCS#1 path: a key that
      // loaded but signed wrongly would look identical up to here.
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
      // Asked for at the mint rather than trusted from the App's grant, so
      // widening the installation later does not widen a sandbox's token.
      expect(body).toEqual({
        repositories: ['infra'],
        permissions: { contents: 'write', pull_requests: 'write' },
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
      // Two discoveries, and the second mint is against the new id.
      expect(github.of('/repos/jonpulsifer/infra/installation')).toHaveLength(
        2,
      );
      expect(github.of('/app/installations/43/access_tokens')).toHaveLength(1);

      // A second 404 in a row is an answer, not a stale id: it is raised.
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

      // Eleven minutes in, 49 are left: a turn starting now could outlive
      // its own credential, so it gets a new one.
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
      // And the held copy is gone, so the next turn cannot be handed a
      // credential that GitHub has already thrown away.
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
      // Bun's fetch has no happy-eyeballs fallback and no default deadline:
      // unbounded, this is a turn that never ends and never says why.
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
      // The request id is what a support question is asked with; the body is
      // what a token could be echoed back in, so it is dropped.
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
  test('names the installation and the expiry, and never the secret', async () => {
    const { app, github, log } = build();
    try {
      const token = await app.token();
      await app.preflight();
      const written = JSON.stringify(log.entries);
      expect(written).toContain('42');
      expect(written).toContain('clanky-bot[bot]');
      expect(written).not.toContain(token.token);
      expect(written).not.toContain('PRIVATE KEY');
    } finally {
      github.stop();
    }
  });
});

test('git is handed the constant username an installation token wants', () => {
  expect(GIT_HTTPS_USERNAME).toBe('x-access-token');
});
