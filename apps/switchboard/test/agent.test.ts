import { afterEach, describe, expect, test } from 'bun:test';
import { AgentLookupError, findAgentId, resolveAgentId } from '../src/agent.ts';
import { ConfigError } from '../src/config.ts';
import type { Fields, Log } from '../src/log.ts';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const opts = { apiKey: 'a-secret-key', name: 'pbx-switchboard' };

type Page = {
  agents: { agent_id: string; name: string }[];
  has_more: boolean;
  next_cursor?: string | null;
};

function mockPages(pages: Record<string, Page>) {
  const requests: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url: String(url), init });
    const cursor = new URL(String(url)).searchParams.get('cursor') ?? '';
    const page = pages[cursor];
    return page
      ? Response.json(page)
      : new Response('no page', { status: 500 });
  }) as unknown as typeof fetch;
  return requests;
}

function fakeLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string, fields?: Fields) =>
    lines.push(JSON.stringify({ msg, ...fields }));
  return { log: { info: capture, warn: capture, error: capture }, lines };
}

const noSleep = async () => {};

describe('findAgentId', () => {
  test('returns the id of the one agent with exactly that name', async () => {
    const requests = mockPages({
      '': {
        agents: [
          { agent_id: 'agent_troll', name: 'pbx-troll' },
          { agent_id: 'agent_sb', name: 'pbx-switchboard' },
          { agent_id: 'agent_other', name: 'pbx-switchboard-old' },
        ],
        has_more: false,
      },
    });
    expect(await findAgentId(opts)).toBe('agent_sb');
    expect(requests).toHaveLength(1);
    const url = new URL(requests[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe(
      'https://api.elevenlabs.io/v1/convai/agents',
    );
    expect(url.searchParams.get('page_size')).toBe('100');
    const headers = requests[0]?.init.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('a-secret-key');
    expect(requests[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  test('follows next_cursor until has_more is false', async () => {
    const requests = mockPages({
      '': {
        agents: [{ agent_id: 'agent_troll', name: 'pbx-troll' }],
        has_more: true,
        next_cursor: 'c2',
      },
      c2: {
        agents: [{ agent_id: 'agent_sb', name: 'pbx-switchboard' }],
        has_more: false,
        next_cursor: null,
      },
    });
    expect(await findAgentId(opts)).toBe('agent_sb');
    expect(
      requests.map((r) => new URL(r.url).searchParams.get('cursor')),
    ).toEqual([null, 'c2']);
  });

  test('no agent of that name is not-found, never a guess', async () => {
    mockPages({
      '': {
        agents: [{ agent_id: 'agent_troll', name: 'pbx-troll' }],
        has_more: false,
      },
    });
    const failure = await findAgentId(opts).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(AgentLookupError);
    expect((failure as AgentLookupError).reason).toBe('not-found');
    expect((failure as AgentLookupError).transient).toBe(false);
  });

  test('two agents of that name is ambiguous', async () => {
    mockPages({
      '': {
        agents: [
          { agent_id: 'agent_a', name: 'pbx-switchboard' },
          { agent_id: 'agent_b', name: 'pbx-switchboard' },
        ],
        has_more: false,
      },
    });
    const failure = await findAgentId(opts).catch((e: unknown) => e);
    expect((failure as AgentLookupError).reason).toBe('ambiguous');
    expect((failure as AgentLookupError).transient).toBe(false);
  });

  test('a 5xx response is a transient http-error', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 503 })) as unknown as typeof fetch;
    const failure = await findAgentId(opts).catch((e: unknown) => e);
    expect((failure as AgentLookupError).reason).toBe('http-error');
    expect((failure as AgentLookupError).httpStatus).toBe(503);
    expect((failure as AgentLookupError).transient).toBe(true);
  });

  test('a refused key is an http-error that is final', async () => {
    for (const status of [401, 403, 404]) {
      globalThis.fetch = (async () =>
        new Response('no', { status })) as unknown as typeof fetch;
      const failure = await findAgentId(opts).catch((e: unknown) => e);
      expect((failure as AgentLookupError).reason).toBe('http-error');
      expect((failure as AgentLookupError).httpStatus).toBe(status);
      expect((failure as AgentLookupError).transient).toBe(false);
    }
  });

  test('a body without an agents list is a bad-response', async () => {
    globalThis.fetch = (async () =>
      Response.json({ detail: 'weird' })) as unknown as typeof fetch;
    const failure = await findAgentId(opts).catch((e: unknown) => e);
    expect((failure as AgentLookupError).reason).toBe('bad-response');
  });

  test('a listing that never ends is refused, not read forever', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({
        agents: [],
        has_more: true,
        next_cursor: `c${requests}`,
      });
    }) as unknown as typeof fetch;
    const failure = await findAgentId(opts).catch((e: unknown) => e);
    expect((failure as AgentLookupError).reason).toBe('bad-response');
    expect(requests).toBe(20);
  });

  test('a timeout and a network failure are reported as such', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('The operation timed out.'), {
        name: 'TimeoutError',
      });
    }) as unknown as typeof fetch;
    const timeout = await findAgentId(opts).catch((e: unknown) => e);
    expect((timeout as AgentLookupError).reason).toBe('timeout');

    globalThis.fetch = (async () => {
      throw new Error('network is unreachable');
    }) as unknown as typeof fetch;
    const network = await findAgentId(opts).catch((e: unknown) => e);
    expect((network as AgentLookupError).reason).toBe('network');
  });

  test('a thrown error never carries the URL or the key', async () => {
    globalThis.fetch = (async () => {
      throw new Error('boom https://api.elevenlabs.io a-secret-key');
    }) as unknown as typeof fetch;
    const failure = (await findAgentId(opts).catch(
      (e: unknown) => e,
    )) as AgentLookupError;
    expect(failure.message).not.toContain('api.elevenlabs.io');
    expect(failure.message).not.toContain(opts.apiKey);
  });
});

describe('resolveAgentId', () => {
  const base = {
    elevenlabsApiKey: 'a-secret-key',
    agentName: 'pbx-switchboard',
  };

  test('an explicit id skips the lookup', async () => {
    const requests = mockPages({});
    const { log } = fakeLog();
    const id = await resolveAgentId(
      { ...base, agentId: 'agent_override' },
      { log },
    );
    expect(id).toBe('agent_override');
    expect(requests).toHaveLength(0);
  });

  test('resolves the name and logs the id, never the key', async () => {
    mockPages({
      '': {
        agents: [{ agent_id: 'agent_sb', name: 'pbx-switchboard' }],
        has_more: false,
      },
    });
    const { log, lines } = fakeLog();
    expect(await resolveAgentId(base, { log })).toBe('agent_sb');
    const dump = lines.join('\n');
    expect(dump).toContain('agent_sb');
    expect(dump).not.toContain('a-secret-key');
    expect(dump).not.toContain('api.elevenlabs.io');
  });

  test('retries a transport failure a bounded number of times, then succeeds', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      if (requests < 3) return new Response('down', { status: 502 });
      return Response.json({
        agents: [{ agent_id: 'agent_sb', name: 'pbx-switchboard' }],
        has_more: false,
      });
    }) as unknown as typeof fetch;
    const slept: number[] = [];
    const { log } = fakeLog();
    const id = await resolveAgentId(base, {
      log,
      attempts: 4,
      delayMs: 7,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(id).toBe('agent_sb');
    expect(requests).toBe(3);
    expect(slept).toEqual([7, 7]);
  });

  test('gives up as a config error once the attempts run out', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      throw new Error('network is unreachable');
    }) as unknown as typeof fetch;
    const { log } = fakeLog();
    const failure = await resolveAgentId(base, {
      log,
      attempts: 3,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).message).toContain('network');
    expect(requests).toBe(3);
  });

  test('a definitive answer is a config error at once, with no retry', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return Response.json({ agents: [], has_more: false });
    }) as unknown as typeof fetch;
    const { log } = fakeLog();
    const failure = await resolveAgentId(base, {
      log,
      attempts: 5,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).message).toContain('not-found');
    expect(requests).toBe(1);
  });

  test('a refused key is a config error after one request', async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests++;
      return new Response('no', { status: 401 });
    }) as unknown as typeof fetch;
    const { log } = fakeLog();
    const failure = await resolveAgentId(base, {
      log,
      attempts: 5,
      sleep: noSleep,
    }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ConfigError);
    expect((failure as ConfigError).message).toContain('http-error');
    expect(requests).toBe(1);
  });
});
