import { afterEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { GithubApp, GithubError } from '../src/github.ts';
import type { Fields, Log } from '../src/log.ts';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

function fakeLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string, fields?: Fields) =>
    lines.push(JSON.stringify({ msg, ...fields }));
  return { log: { info: capture, warn: capture, error: capture }, lines };
}

interface Seen {
  method: string;
  path: string;
  auth: string;
  body: unknown;
}

/** A GitHub of its own: answers each route and records what it saw. */
function fakeGithub(opts: { fileContent: string; autoMergeFails?: boolean }) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(String(url));
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    const path = u.pathname + u.search;
    seen.push({
      method: init.method ?? 'GET',
      path,
      auth: headers.authorization ?? '',
      body,
    });
    if (path === '/repos/o/r/installation') {
      return Response.json({ id: 42, app_slug: 'clanky-bot' });
    }
    if (path === '/app/installations/42/access_tokens') {
      return Response.json({
        token: 'ghs_installation',
        expires_at: '2026-01-01T00:00:00Z',
      });
    }
    if (path === '/repos/o/r/git/ref/heads/main') {
      return Response.json({ object: { sha: 'abc123' } });
    }
    if (
      path.startsWith('/repos/o/r/contents/dir%2Fagent.json') ||
      path.startsWith('/repos/o/r/contents/dir/agent.json')
    ) {
      if ((init.method ?? 'GET') === 'GET') {
        return Response.json({
          content: Buffer.from(opts.fileContent).toString('base64'),
          sha: 'blob1',
        });
      }
      return Response.json({ commit: { sha: 'c1' } }, { status: 201 });
    }
    if (path === '/repos/o/r/git/refs')
      return Response.json({ ref: body.ref }, { status: 201 });
    if (path === '/repos/o/r/pulls') {
      return Response.json(
        {
          html_url: 'https://github.com/o/r/pull/7',
          number: 7,
          node_id: 'PR_7',
        },
        { status: 201 },
      );
    }
    if (path === '/graphql') {
      return opts.autoMergeFails
        ? Response.json({ errors: [{ message: 'not mergeable' }] })
        : Response.json({ data: { enablePullRequestAutoMerge: {} } });
    }
    return new Response('no route', { status: 404 });
  }) as unknown as typeof fetch;
  return seen;
}

const snapshot = {
  path: 'dir/agent.json',
  content: '{\n  "a": 2\n}\n',
  branch: 'persona/agent-1',
  title: 'chore: snapshot',
  body: 'body',
  base: 'main',
};

describe('GithubApp', () => {
  test('a bad key fails at construction', () => {
    const { log } = fakeLog();
    expect(
      () =>
        new GithubApp({
          appId: '1',
          privateKey: 'nope',
          owner: 'o',
          repo: 'r',
          log,
        }),
    ).toThrow(GithubError);
  });

  test('opens a snapshot: branch from main, one file, a pull request, auto-merge', async () => {
    const seen = fakeGithub({ fileContent: '{\n  "a": 1\n}\n' });
    const { log } = fakeLog();
    const app = new GithubApp({
      appId: '1',
      privateKey: pem,
      owner: 'o',
      repo: 'r',
      log,
    });
    const result = await app.openSnapshot(snapshot);
    expect(result).toEqual({
      url: 'https://github.com/o/r/pull/7',
      number: 7,
      autoMerge: true,
    });

    const mint = seen.find(
      (s) => s.path === '/app/installations/42/access_tokens',
    );
    expect(mint?.auth).toMatch(/^Bearer ey/);
    expect(mint?.body).toEqual({
      repositories: ['r'],
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    const ref = seen.find((s) => s.path === '/repos/o/r/git/refs');
    expect(ref?.body).toEqual({
      ref: 'refs/heads/persona/agent-1',
      sha: 'abc123',
    });
    expect(ref?.auth).toBe('Bearer ghs_installation');
    const put = seen.find((s) => s.method === 'PUT');
    expect(put?.body).toEqual({
      message: 'chore: snapshot',
      content: Buffer.from(snapshot.content).toString('base64'),
      sha: 'blob1',
      branch: 'persona/agent-1',
    });
    const pr = seen.find((s) => s.path === '/repos/o/r/pulls');
    expect(pr?.body).toEqual({
      title: 'chore: snapshot',
      body: 'body',
      head: 'persona/agent-1',
      base: 'main',
    });
    const merge = seen.find((s) => s.path === '/graphql');
    expect(
      (merge?.body as { variables?: unknown } | undefined)?.variables,
    ).toEqual({
      id: 'PR_7',
    });
  });

  test('a refused auto-merge still answers the pull request', async () => {
    fakeGithub({ fileContent: '{}\n', autoMergeFails: true });
    const { log, lines } = fakeLog();
    const app = new GithubApp({
      appId: '1',
      privateKey: pem,
      owner: 'o',
      repo: 'r',
      log,
    });
    const result = await app.openSnapshot(snapshot);
    expect(result.autoMerge).toBe(false);
    expect(result.number).toBe(7);
    expect(lines.some((l) => l.includes('snapshot auto-merge not armed'))).toBe(
      true,
    );
  });

  test('a file that already matches opens nothing', async () => {
    const seen = fakeGithub({ fileContent: snapshot.content });
    const { log } = fakeLog();
    const app = new GithubApp({
      appId: '1',
      privateKey: pem,
      owner: 'o',
      repo: 'r',
      log,
    });
    await expect(app.openSnapshot(snapshot)).rejects.toThrow('already matches');
    expect(
      seen.some((s) => s.method === 'PUT' || s.path === '/repos/o/r/pulls'),
    ).toBe(false);
  });

  test('a failure names the step and the status, never the body', async () => {
    globalThis.fetch = (async () =>
      new Response('{"message":"secret-ish ghs_token"}', {
        status: 403,
      })) as unknown as typeof fetch;
    const { log } = fakeLog();
    const app = new GithubApp({
      appId: '1',
      privateKey: pem,
      owner: 'o',
      repo: 'r',
      log,
    });
    await expect(app.openSnapshot(snapshot)).rejects.toThrow(
      'find installation: HTTP 403',
    );
  });
});
