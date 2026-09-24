/**
 * `/api/ai` against a stub upstream, since much of what the route promises is
 * about the request it sends: headers, query string and `include_usage`.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_AI_BODY_BYTES,
  MAX_AI_IN_FLIGHT_SITE,
  MAX_AI_REQUESTS_DAY,
  MAX_AI_TOKENS_DAY,
  utcDay,
} from '../../server/ai.ts';
import { readConfig } from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let seen: Seen | null = null;
let reply: (request: Request) => Response | Promise<Response> = () =>
  Response.json({});

/** Records what it was sent and answers with `reply`. */
const upstream = Bun.serve({
  port: 0,
  async fetch(request) {
    seen = {
      method: request.method,
      url: request.url,
      headers: Object.fromEntries(request.headers),
      body: request.method === 'POST' ? await request.text() : '',
    };
    return reply(request);
  },
});

afterAll(() => {
  upstream.stop(true);
});

const OPERATOR_KEY = 'operator-key';

const kthx = withServer({
  aiUrl: `http://127.0.0.1:${upstream.port}/v1`,
  aiKey: OPERATOR_KEY,
  aiModel: 'test-model',
  aiModels: ['test-model', 'other-model'],
  aiMaxTokens: 100,
});

beforeEach(() => {
  seen = null;
  reply = () =>
    Response.json({
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
      usage: { total_tokens: 42 },
    });
});

// Its own address block: the claim caps are module-level, so test files that
// share addresses spend each other's day.
let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `100.64.0.${nextAddress % 250}`;
}

interface Site {
  readonly name: string;
  readonly host: string;
  readonly token: string;
}

async function claimed(label: string, at = kthx): Promise<Site> {
  const name = at().name(label);
  const response = await at().fetch(
    ask('/api/sites', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
      address: address(),
    }),
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { token: string };
  return { name, host: `${name}.${ZONE}`, token: body.token };
}

function chat(
  site: Site,
  body: unknown,
  init: Parameters<typeof ask>[1] = {},
  at = kthx,
): Promise<Response> {
  return at().fetch(
    ask('/api/ai/v1/chat/completions', {
      host: site.host,
      method: 'POST',
      ...init,
      headers: { 'content-type': 'application/json', ...init.headers },
      body: JSON.stringify(body),
    }),
  );
}

function sent(): Record<string, unknown> {
  return JSON.parse(seen?.body ?? '{}') as Record<string, unknown>;
}

function session(): string | undefined {
  return seen?.headers['x-opencode-session'];
}

/** Polls: tokens are billed after the answer is sent. */
async function spent(
  site: Site,
): Promise<{ requests: number; tokens: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = (await kthx().sql`
      select requests, tokens from ai_usage
      where site = ${site.name} and day = ${utcDay()}
    `) as { requests: number; tokens: string }[];
    const counted = {
      requests: Number(row?.requests ?? 0),
      tokens: Number(row?.tokens ?? 0),
    };
    if (counted.tokens > 0) return counted;
    await Bun.sleep(10);
  }
  throw new Error('no tokens were ever billed');
}

/** Polls: the refund, like the bill, is written after the answer is sent. */
async function counted(
  site: Site,
  want: number,
): Promise<{ requests: number; tokens: number }> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [row] = (await kthx().sql`
      select requests, tokens from ai_usage
      where site = ${site.name} and day = ${utcDay()}
    `) as { requests: number; tokens: string }[];
    const counted = {
      requests: Number(row?.requests ?? 0),
      tokens: Number(row?.tokens ?? 0),
    };
    if (counted.requests === want) return counted;
    await Bun.sleep(10);
  }
  throw new Error(`the day never settled at ${want} requests`);
}

/** Captures `console.error` while `run` runs. */
async function complaints(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const complain = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    await run();
  } finally {
    console.error = complain;
  }
  return lines;
}

function stream(
  frames: readonly string[],
  type = 'text/event-stream',
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) {
          controller.enqueue(new TextEncoder().encode(frame));
        }
        controller.close();
      },
    }),
    { headers: { 'content-type': type } },
  );
}

describe('the passthrough', () => {
  test('relays a completion and bills the usage the upstream reported', async () => {
    const site = await claimed('ai-relay');
    const response = await chat(site, {
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { usage: { total_tokens: number } };
    expect(body.usage.total_tokens).toBe(42);

    expect(seen?.url).toBe(
      `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
    );
    expect(await spent(site)).toEqual({ requests: 1, tokens: 42 });
  });

  test('sends the operator key and none of what the client attached', async () => {
    const site = await claimed('ai-headers');
    await chat(
      site,
      { messages: [] },
      {
        headers: {
          authorization: 'Bearer a-token-the-page-invented',
          cookie: '__Host-kthx_me=someone',
          'x-forwarded-for': '203.0.113.9',
          'openai-organization': 'someone-elses',
        },
      },
    );

    expect(seen?.headers.authorization).toBe(`Bearer ${OPERATOR_KEY}`);
    expect(seen?.headers.cookie).toBeUndefined();
    expect(seen?.headers['x-forwarded-for']).toBeUndefined();
    expect(seen?.headers['openai-organization']).toBeUndefined();
  });

  test("sends a session header of its own, never the caller's", async () => {
    const site = await claimed('ai-session');
    await chat(
      site,
      { messages: [] },
      { headers: { 'x-opencode-session': 'someone-elses-session' } },
    );
    const mine = session();
    // The Go base answers 400 MissingSessionID without one, and a page that
    // chose it could file its calls under another site's.
    expect(mine).toMatch(/^kthx-[0-9a-f]{32}$/);

    // Stable per site: routing metadata that changes every call groups nothing.
    await chat(site, { messages: [] });
    expect(session()).toBe(mine as string);
    const other = await claimed('ai-session-other');
    await chat(other, { messages: [] });
    expect(session()).not.toBe(mine as string);
  });

  test('drops the query string a caller appended', async () => {
    const site = await claimed('ai-query');
    await kthx().fetch(
      ask('/api/ai/v1/chat/completions?api-key=leak&model=elsewhere', {
        host: site.host,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: [] }),
      }),
    );
    expect(seen?.url).toBe(
      `http://127.0.0.1:${upstream.port}/v1/chat/completions`,
    );
  });

  test('fills in the default model and clamps max_tokens', async () => {
    const site = await claimed('ai-defaults');
    await chat(site, { messages: [], max_tokens: 999_999 });
    expect(sent().model).toBe('test-model');
    expect(sent().max_tokens).toBe(100);
  });

  test('clamps both token spellings, and bills the higher of the two', async () => {
    const site = await claimed('ai-both-keys');
    reply = () => Response.json({ choices: [{ message: { content: 'hi' } }] });
    const response = await chat(site, {
      messages: [],
      max_tokens: 999_999,
      max_completion_tokens: 5,
    });
    await response.json();
    expect(sent().max_tokens).toBe(100);
    expect(sent().max_completion_tokens).toBe(5);
    expect(await spent(site)).toEqual({ requests: 1, tokens: 100 });
  });

  test('refuses a model outside the allow-list before calling anyone', async () => {
    const site = await claimed('ai-model');
    const response = await chat(site, { messages: [], model: 'expensive-1' });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_MODEL');
    expect(seen).toBeNull();
  });

  test('refuses n > 1: the bill is a multiple the budget cannot see', async () => {
    const site = await claimed('ai-n');
    const response = await chat(site, { messages: [], n: 4 });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('MALFORMED_REQUEST');
    expect(seen).toBeNull();
  });

  test('refuses a body past the ceiling', async () => {
    const site = await claimed('ai-large');
    const response = await chat(site, {
      messages: [{ role: 'user', content: 'x'.repeat(MAX_AI_BODY_BYTES) }],
    });
    expect(response.status).toBe(413);
    expect(seen).toBeNull();
  });

  test('an upstream that refuses the deployment is 502, never 401', async () => {
    const site = await claimed('ai-401');
    reply = () => Response.json({ error: 'bad key' }, { status: 401 });
    const response = await chat(site, { messages: [] });
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('AI_UPSTREAM');
  });

  test('relays a refusal the caller caused, and keeps the request spent', async () => {
    const site = await claimed('ai-400');
    reply = () =>
      Response.json({ error: { message: 'no such model' } }, { status: 400 });
    const response = await chat(site, { messages: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('no such model');
    // No completion, so no tokens; the request spent at dispatch stays spent.
    expect(await counted(site, 1)).toEqual({ requests: 1, tokens: 0 });
    await Bun.sleep(50);
    expect(await counted(site, 1)).toEqual({ requests: 1, tokens: 0 });
  });

  test('a body the upstream refuses cannot be looped for free', async () => {
    const site = await claimed('ai-loop');
    reply = () =>
      Response.json({ error: { message: 'bad role' } }, { status: 400 });
    for (let i = 0; i < 5; i += 1) {
      expect((await chat(site, { messages: [] })).status).toBe(400);
    }
    expect(await counted(site, 5)).toEqual({ requests: 5, tokens: 0 });
  });

  test('an upstream 500 is 502 AI_UPSTREAM, logged, and refunded', async () => {
    const site = await claimed('ai-500');
    reply = () => Response.json({ error: 'boom' }, { status: 500 });
    const lines = await complaints(async () => {
      const response = await chat(site, { messages: [] });
      // Not relayed: a 5xx gives a page nothing to act on.
      expect(response.status).toBe(502);
      expect((await response.json()).code).toBe('AI_UPSTREAM');
      // Refunded: the deployment's fault, not the body's.
      expect(await counted(site, 0)).toEqual({ requests: 0, tokens: 0 });
    });
    // A header the upstream wanted and did not get leaves no other signal.
    expect(lines.some((line) => line.includes('upstream 500'))).toBe(true);
  });

  test('a request the upstream answered stays spent', async () => {
    const site = await claimed('ai-no-refund');
    await (await chat(site, { messages: [] })).json();
    expect(await spent(site)).toEqual({ requests: 1, tokens: 42 });
    // A refund would be written after the answer, so wait for a late one.
    await Bun.sleep(50);
    expect(await counted(site, 1)).toEqual({ requests: 1, tokens: 42 });
  });
});

describe('the allow-list of paths', () => {
  test('the model list is answered here, unmetered, and reaches no upstream', async () => {
    const site = await claimed('ai-models');
    const response = await kthx().fetch(
      ask('/api/ai/v1/models', { host: site.host }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { id: string }[] };
    expect(body.data.map((entry) => entry.id)).toEqual([
      'test-model',
      'other-model',
    ]);
    // A `no-cors` GET carries no `Origin`, so a metered model list would let a
    // foreign page spend a site's day.
    expect(seen).toBeNull();
    const rows = (await kthx().sql`
      select requests from ai_usage where site = ${site.name}
    `) as { requests: number }[];
    expect(rows).toHaveLength(0);
  });

  test("embeddings are this server's own 404, and cost nothing", async () => {
    const site = await claimed('ai-embed');
    // Neither upstream base has the endpoint (both answer `404 text/html`), so
    // forwarding would only spend the site's billing floor.
    for (const path of ['/api/ai/embeddings', '/api/ai/v1/embeddings']) {
      const response = await kthx().fetch(
        ask(path, {
          host: site.host,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'hi' }),
        }),
      );
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    }
    expect(seen).toBeNull();
    const rows = (await kthx().sql`
      select requests from ai_usage where site = ${site.name}
    `) as { requests: number }[];
    expect(rows).toHaveLength(0);
  });

  test('anything else is 404 and reaches no upstream', async () => {
    const site = await claimed('ai-refuse');
    for (const path of [
      '/api/ai/v1/images/generations',
      '/api/ai/v1/audio/speech',
      '/api/ai/v1/responses',
      '/api/ai',
    ]) {
      const response = await kthx().fetch(
        ask(path, {
          host: site.host,
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(seen).toBeNull();
  });

  test('a known path with the wrong verb is 405', async () => {
    const site = await claimed('ai-verb');
    const response = await kthx().fetch(
      ask('/api/ai/v1/chat/completions', { host: site.host }),
    );
    expect(response.status).toBe(405);
    expect(seen).toBeNull();
  });
});

describe('streaming', () => {
  test('injects include_usage and bills the final chunk', async () => {
    const site = await claimed('ai-stream');
    reply = () =>
      stream([
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: {"choices":[],"usage":{"total_tokens":77}}\n\n',
        'data: [DONE]\n\n',
      ]);

    const response = await chat(site, { messages: [], stream: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(sent().stream_options).toEqual({ include_usage: true });

    const body = await response.text();
    expect(body).toContain('"content":"he"');
    expect(body).toContain('[DONE]');
    expect(await spent(site)).toEqual({ requests: 1, tokens: 77 });
  });

  test('a stream that reports no usage is billed its clamped ceiling', async () => {
    const site = await claimed('ai-nousage');
    reply = () =>
      stream([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    await (await chat(site, { messages: [], stream: true })).text();
    expect(await spent(site)).toEqual({ requests: 1, tokens: 100 });
  });
});

describe('the budget', () => {
  test('a spent day is 429 AI_BUDGET with a retry-after, and calls nobody', async () => {
    const site = await claimed('ai-budget');
    await kthx().sql`
      insert into ai_usage (site, day, requests, tokens)
      values (${site.name}, ${utcDay()}, ${MAX_AI_REQUESTS_DAY}, 0)
    `;
    const response = await chat(site, { messages: [] });
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('AI_BUDGET');
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(seen).toBeNull();
  });

  test('a day past the token ceiling is 429 too, not only the request one', async () => {
    const site = await claimed('ai-tokens');
    await kthx().sql`
      insert into ai_usage (site, day, requests, tokens)
      values (${site.name}, ${utcDay()}, 1, ${MAX_AI_TOKENS_DAY})
    `;
    const response = await chat(site, { messages: [] });
    expect(response.status).toBe(429);
    expect((await response.json()).code).toBe('AI_BUDGET');
    expect(seen).toBeNull();
  });

  test('/api/ai/usage reports today and does not spend it', async () => {
    const site = await claimed('ai-usage');
    await (await chat(site, { messages: [] })).json();
    await spent(site);

    const response = await kthx().fetch(
      ask('/api/ai/usage', { host: site.host }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      day: string;
      requests: number;
      tokens: number;
      quotas: { requests_day: number; tokens_day: number };
    };
    expect(body.day).toBe(utcDay());
    expect(body.requests).toBe(1);
    expect(body.tokens).toBe(42);
    expect(body.quotas.requests_day).toBe(MAX_AI_REQUESTS_DAY);
  });

  test("the owner's site record carries today's numbers", async () => {
    const site = await claimed('ai-inspect');
    await (await chat(site, { messages: [] })).json();
    await spent(site);

    const response = await kthx().fetch(
      ask(`/api/sites/${site.name}`, { token: site.token }),
    );
    const body = (await response.json()) as {
      usage: { ai_requests_today: number; ai_tokens_today: number };
    };
    expect(body.usage.ai_requests_today).toBe(1);
    expect(body.usage.ai_tokens_today).toBe(42);
  });
});

describe('concurrency', () => {
  test('a call past the per-site in-flight cap is 429 with a retry-after', async () => {
    const site = await claimed('ai-inflight');
    let start = (): void => {};
    const held = new Promise<void>((resolve) => {
      start = resolve;
    });
    reply = async () => {
      await held;
      return Response.json({ choices: [], usage: { total_tokens: 1 } });
    };

    const waiting = Array.from({ length: MAX_AI_IN_FLIGHT_SITE }, () =>
      chat(site, { messages: [] }),
    );
    // They hold their slots while the upstream sits on the answer.
    await Bun.sleep(100);
    const refused = await chat(site, { messages: [] });
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('RATE_LIMITED');
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);

    start();
    for (const call of await Promise.all(waiting)) {
      expect(call.status).toBe(200);
      await call.text();
    }
    // The slot returns with the answer, before the client reads the body.
    const after = await chat(site, { messages: [] });
    expect(after.status).toBe(200);
    await after.text();
  });
});

describe('the model configuration', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
  };

  test('a default model outside its own allow-list refuses to boot', () => {
    // A body with no model gets this one before the list check, so a typo
    // would answer every such call 400 INVALID_MODEL.
    expect(() =>
      readConfig({
        ...env,
        KTHX_AI_MODEL: 'mimo-v2.5-pr',
        KTHX_AI_MODELS: 'mimo-v2.5-pro,kimi-k2.7-code',
      }),
    ).toThrow('is not one of KTHX_AI_MODELS');
    expect(
      readConfig({
        ...env,
        KTHX_AI_MODEL: 'mimo-v2.5-pro',
        KTHX_AI_MODELS: 'mimo-v2.5-pro,kimi-k2.7-code',
      }).aiModel,
    ).toBe('mimo-v2.5-pro');
    // An empty list allows every model the upstream has.
    expect(readConfig({ ...env, KTHX_AI_MODEL: 'anything' }).aiModels).toEqual(
      [],
    );
  });

  test('the build ceiling is its own number, and defaults to the public one', () => {
    expect(
      readConfig({ ...env, KTHX_AI_MAX_TOKENS: '4096' }).aiBuildMaxTokens,
    ).toBe(4096);
    // A build writes a whole document; the public ceiling, which is also the
    // floor a silent answer is billed, stays put.
    expect(
      readConfig({
        ...env,
        KTHX_AI_MAX_TOKENS: '4096',
        KTHX_AI_BUILD_MAX_TOKENS: '16000',
      }),
    ).toMatchObject({ aiMaxTokens: 4096, aiBuildMaxTokens: 16000 });
  });
});

describe('without a key', () => {
  const keyless = withServer({
    aiUrl: `http://127.0.0.1:${upstream.port}/v1`,
    aiKey: null,
    aiModel: 'test-model',
    aiModels: ['test-model'],
    aiMaxTokens: 100,
  });

  test('a deployment with no KTHX_AI_KEY is 502, and calls nobody', async () => {
    const site = await claimed('ai-keyless', keyless);
    const response = await chat(site, { messages: [] }, {}, keyless);
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe('AI_UPSTREAM');
    expect(seen).toBeNull();
  });
});
