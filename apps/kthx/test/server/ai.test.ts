/**
 * `/api/ai`: what reaches the upstream, what comes back, and what it costs.
 *
 * A real stub upstream rather than a mocked `fetch`, because half of what this
 * route promises is about the request it *sends*: that the client's
 * `Authorization` is gone, that the operator's is there, that the query string
 * did not survive, and that `stream_options.include_usage` was added to a
 * stream the caller did not ask to have metered.
 *
 * The budget is real Postgres for the same reason it is in Postgres at all: a
 * counter this process held would be a claim about a Map, not about money.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  MAX_AI_BODY_BYTES,
  MAX_AI_REQUESTS_DAY,
  utcDay,
} from '../../server/ai.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

let seen: Seen | null = null;
let reply: (request: Request) => Response = () => Response.json({});

/** The upstream, near enough: it records what it was sent and answers to order. */
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

// Its own block: the claim cap is a module-level counter, so two test files
// sharing an address range spend each other's day.
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

async function claimed(label: string): Promise<Site> {
  const name = kthx().name(label);
  const response = await kthx().fetch(
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
): Promise<Response> {
  return kthx().fetch(
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

/** The row as it settles: tokens are billed after the answer is on the wire. */
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

  test('relays a refusal the upstream composed, and bills nothing for it', async () => {
    const site = await claimed('ai-400');
    reply = () =>
      Response.json({ error: { message: 'no such model' } }, { status: 400 });
    const response = await chat(site, { messages: [] });
    expect(response.status).toBe(400);
    const [row] = (await kthx().sql`
      select requests, tokens from ai_usage where site = ${site.name}
    `) as { requests: number; tokens: string }[];
    expect(Number(row?.requests)).toBe(1);
    expect(Number(row?.tokens)).toBe(0);
  });
});

describe('the allow-list of paths', () => {
  test('models and embeddings are relayed', async () => {
    const site = await claimed('ai-paths');
    reply = () => Response.json({ data: [{ id: 'test-model' }] });
    const models = await kthx().fetch(
      ask('/api/ai/v1/models', { host: site.host }),
    );
    expect(models.status).toBe(200);
    expect(seen?.url).toBe(`http://127.0.0.1:${upstream.port}/v1/models`);

    reply = () => Response.json({ data: [{ embedding: [0.1] }], usage: {} });
    const embeddings = await kthx().fetch(
      ask('/api/ai/embeddings', {
        host: site.host,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: 'hi' }),
      }),
    );
    expect(embeddings.status).toBe(200);
    expect(seen?.url).toBe(`http://127.0.0.1:${upstream.port}/v1/embeddings`);
    expect(sent().model).toBe('test-model');
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
