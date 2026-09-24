/**
 * `POST /api/build`: which door has it, what is not trusted about an answer,
 * and what it costs. The claims are about timing, so the stubs are slow and
 * {@link arriving} reads a body while it streams.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { LANDING_PATH } from '@repo/kthx/assets';
import { tarGz } from '../../cli/tar.ts';
import { utcDay } from '../../server/ai.ts';
import {
  documentIn,
  HEADERS_MS,
  MAX_BUILD_REQUESTS_DAY,
  nameIn,
  slugOf,
} from '../../server/build.ts';
import { readConfig } from '../../server/env.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

const CONTROL = 'ops.kthx-private.test';
const IDENTITY = 'kthx.tailnet.test';
const PROXY = '10.42.0.7';
const DAD = 'dad@example.test';
const MOM = 'mom@example.test';

const PAGE =
  '<!doctype html><html><head><title>Boards</title></head><body><h1>Boards</h1></body></html>';

interface Seen {
  readonly model: string;
  readonly session: string | null;
  readonly messages: { role: string; content: string }[];
  readonly maxTokens: unknown;
  readonly stream: unknown;
}

let asked: Seen[] = [];
let answers: ((request: Request) => Response | Promise<Response>)[] = [];

/** Records what it was asked and answers with the next of `answers`. */
const upstream = Bun.serve({
  port: 0,
  // Bun's default would cut a forty-second think before the server under test.
  idleTimeout: 255,
  async fetch(request) {
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens: unknown;
      stream: unknown;
    };
    asked.push({
      model: body.model,
      session: request.headers.get('x-opencode-session'),
      messages: body.messages,
      maxTokens: body.max_tokens,
      stream: body.stream,
    });
    const answer = answers.shift();
    return answer === undefined
      ? new Response('', { status: 500 })
      : answer(request);
  },
});

afterAll(() => {
  upstream.stop(true);
});

const kthx = withServer({
  controlHost: CONTROL,
  identityHost: IDENTITY,
  // Loopback too: the real-socket test arrives over it and must be vouched for.
  tailnetProxies: ['10.42.0.0/16', '127.0.0.1', '::1'],
  aiUrl: `http://127.0.0.1:${upstream.port}/v1`,
  aiKey: 'operator-key',
  aiModel: 'chat-model',
  aiModels: [],
  aiMaxTokens: 4096,
  aiBuildMaxTokens: 16000,
  aiBuildModel: 'writer',
  aiBuildFallbackModel: 'second-writer',
});

beforeEach(() => {
  asked = [];
  answers = [];
});

/** One SSE frame per piece of text, then usage, then `[DONE]`. */
function frames(pieces: readonly string[], tokens = 900): string {
  return [
    ...pieces.map(
      (piece) =>
        `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`,
    ),
    `data: ${JSON.stringify({ choices: [], usage: { total_tokens: tokens } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function writes(pieces: readonly string[], tokens = 900): Response {
  return new Response(frames(pieces, tokens), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * Quiet before the first content byte and again mid-body: Bun's idle timer
 * treats the two differently, and the route must survive both.
 */
function writesSlowly(
  before: number,
  gap: number,
  first: string,
  rest: readonly string[],
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Reasoning first, as the real base streams it.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'mm' } }] })}\n\n`,
        ),
      );
      await Bun.sleep(before);
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`,
        ),
      );
      await Bun.sleep(gap);
      controller.enqueue(encoder.encode(frames(rest)));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * The enqueue after the sleep may hit a stream the server already cancelled;
 * unguarded, it would fail the run from inside this stub.
 */
function thinksFor(
  ms: number,
  first: string,
  rest: readonly string[],
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // The real base sends headers within a second and streams
      // `reasoning_content` until the first content delta.
      controller.enqueue(
        encoder.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'mm' } }] })}\n\n`,
        ),
      );
      await Bun.sleep(ms);
      try {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: first } }] })}\n\n`,
          ),
        );
        controller.enqueue(encoder.encode(frames(rest)));
        controller.close();
      } catch {
        // The server hung up, as the test intends.
      }
    },
  });
  return new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A model that reasons for its whole ceiling and writes nothing at all. */
function thinksOnly(): Response {
  return new Response(
    [
      `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'hmm' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { total_tokens: 16000 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

function peer(address: string): Bun.Server<unknown> {
  return {
    requestIP: () => ({ address, port: 1, family: 'IPv4' }),
    timeout: () => undefined,
  } as unknown as Bun.Server<unknown>;
}

function ontailnet(
  path: string,
  login: string | null,
  init: Parameters<typeof ask>[1] = {},
) {
  const { headers, ...rest } = init;
  return kthx().fetch(
    ask(path, {
      host: IDENTITY,
      headers: {
        ...(login === null ? {} : { 'tailscale-user-login': login }),
        ...headers,
      },
      ...rest,
    }),
    peer(PROXY),
  );
}

function post(body: unknown, login: string | null = DAD) {
  return ontailnet('/api/build', login, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/**
 * Each frame with the millisecond it arrived: a body sent all at once and one
 * that streams are the same array once read to the end.
 */
async function* arriving(
  response: Response,
): AsyncGenerator<{ frame: Record<string, unknown>; at: number }> {
  const reader = response.body?.getReader();
  if (reader === undefined) return;
  const decoder = new TextDecoder();
  let held = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done || chunk.value === undefined) return;
    held += decoder.decode(chunk.value, { stream: true });
    const lines = held.split('\n');
    held = lines.pop() ?? '';
    for (const line of lines) {
      if (line.trim() === '') continue;
      yield {
        frame: JSON.parse(line) as Record<string, unknown>,
        at: Date.now(),
      };
    }
  }
}

async function read(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const done = (all: Record<string, unknown>[]) =>
  all.find((frame) => frame.t === 'done') ?? null;
const failed = (all: Record<string, unknown>[]) =>
  all.find((frame) => frame.t === 'error') ?? null;

/** Sleeps first: the route does not await `bill` and `refundRequest`. */
async function spent(
  login = DAD,
): Promise<{ requests: number; tokens: number }> {
  await Bun.sleep(150);
  const [row] = (await kthx().sql`
    select requests, tokens from build_usage
    where login = ${login} and day = ${utcDay()}
  `) as { requests: number; tokens: string | number }[];
  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
  };
}

async function claimAs(login: string, label: string): Promise<string> {
  const name = kthx().name(label);
  const claimed = await ontailnet('/api/sites', login, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(claimed.status).toBe(201);
  return name;
}

async function publish(
  login: string,
  name: string,
  files: { path: string; bytes: Uint8Array }[],
): Promise<void> {
  const uploaded = await ontailnet(`/api/sites/${name}/releases`, login, {
    method: 'POST',
    headers: {
      'content-type': 'application/gzip',
      origin: `https://${IDENTITY}`,
    },
    body: tarGz(files),
  });
  expect(uploaded.status).toBe(201);
}

const bytes = (text: string) => new TextEncoder().encode(text);

describe('the route', () => {
  test('exists on the identity host and nowhere else', async () => {
    for (const host of [ZONE, CONTROL]) {
      const response = await kthx().fetch(
        ask('/api/build', {
          host,
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'tailscale-user-login': DAD,
          },
          body: JSON.stringify({ ask: 'a page' }),
        }),
        peer(PROXY),
      );
      expect(response.status).toBe(404);
      expect((await response.json()).code).toBe('NOT_FOUND');
    }
    expect(asked).toHaveLength(0);
  });

  test('needs a login, and a same-site origin', async () => {
    expect((await post({ ask: 'a page' }, null)).status).toBe(401);

    const crossed = await ontailnet('/api/build', DAD, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://evil.test',
      },
      body: JSON.stringify({ ask: 'a page' }),
    });
    expect(crossed.status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  test('refuses a body that is not one sentence about a business', async () => {
    for (const body of [{}, { ask: '   ' }, { ask: 'x'.repeat(4001) }]) {
      const refused = await post(body);
      expect(refused.status).toBe(400);
      expect((await refused.json()).code).toBe('MALFORMED_REQUEST');
    }
    expect(asked).toHaveLength(0);
  });
});

describe('a page', () => {
  test('is written, named, and kept where a closed tab can find it', async () => {
    answers = [
      () => writes(['<!-- kthx-name: dartmouth-boards -->\n', PAGE], 1234),
    ];
    const all = await read(await post({ ask: 'A page for my woodworking.' }));

    // Open before any model is asked, naming the one it waits on.
    expect(all[0]).toEqual({ t: 'accepted' });
    expect(all[1]).toMatchObject({ t: 'thinking', model: 'writer' });
    expect(all.find((frame) => frame.t === 'start')).toEqual({
      t: 'start',
      model: 'writer',
    });
    // The page can say how much has been written.
    expect(all.some((frame) => frame.t === 'writing')).toBe(true);
    const last = done(all);
    expect(last).toMatchObject({
      name: 'dartmouth-boards',
      site: null,
      available: true,
      unchanged: false,
      document: PAGE,
      url: `https://dartmouth-boards.${ZONE}`,
    });

    // The build model and ceiling, whatever the caller sent.
    expect(asked[0]).toMatchObject({
      model: 'writer',
      maxTokens: 16000,
      stream: true,
    });
    expect(asked[0]?.session).toMatch(/^kthx-build-[0-9a-f]{32}$/);
    expect(asked[0]?.messages[0]?.role).toBe('system');

    // The row exists before anything is claimed: no site was made here.
    const id = last?.build as string;
    const kept = await ontailnet(`/api/build/${id}`, DAD);
    expect(kept.status).toBe(200);
    expect(await kept.json()).toMatchObject({
      id,
      name: 'dartmouth-boards',
      site: null,
      document: PAGE,
    });
    const [row] = (await kthx().sql`
      select count(*)::int as sites from sites where name = 'dartmouth-boards'
    `) as { sites: number }[];
    expect(row?.sites).toBe(0);
  });

  test('is somebody else’s draft to nobody', async () => {
    answers = [() => writes([`<!-- kthx-name: mine-only -->\n${PAGE}`])];
    const last = done(await read(await post({ ask: 'my page' })));
    const hers = await ontailnet(`/api/build/${last?.build as string}`, MOM);
    expect(hers.status).toBe(404);
  });

  test('gets a name from what was typed when the model forgets to propose one', async () => {
    answers = [() => writes([PAGE])];
    const last = done(await read(await post({ ask: 'MY CAT!!! Biscuit' })));
    expect(last?.name).toBe('my-cat-biscuit');
    expect(last?.available).toBe(true);
  });

  test('never takes a name a claim would refuse', async () => {
    answers = [() => writes([`<!-- kthx-name: admin -->\n${PAGE}`])];
    const last = done(await read(await post({ ask: 'a page for the club' })));
    expect(last?.name).toBe('a-page-for-the-club');
  });

  test('says a name is taken rather than finding out at the claim', async () => {
    const name = await claimAs(MOM, 'held-name');
    answers = [() => writes([`<!-- kthx-name: ${name} -->\n${PAGE}`])];
    const last = done(await read(await post({ ask: 'another page' })));
    expect(last).toMatchObject({ name, available: false, yours: null });
  });

  test('never offers this person their own address as somebody else’s', async () => {
    // The same description proposes the same name, so it must read as his.
    const empty = await claimAs(DAD, 'his-own');
    answers = [() => writes([`<!-- kthx-name: ${empty} -->\n${PAGE}`])];
    expect(
      done(await read(await post({ ask: 'my woodworking' }))),
    ).toMatchObject({ name: empty, available: false, yours: 'empty' });

    // An empty claim is finished by publishing; a live site needs a new name.
    const live = await claimAs(DAD, 'his-site');
    await publish(DAD, live, [{ path: 'index.html', bytes: bytes(PAGE) }]);
    answers = [() => writes([`<!-- kthx-name: ${live} -->\n${PAGE}`])];
    expect(
      done(await read(await post({ ask: 'my woodworking' }))),
    ).toMatchObject({ name: live, available: false, yours: 'live' });
  });

  test('is refused when the answer is not a page', async () => {
    answers = [() => writes(['I would be happy to help you with that!'])];
    const all = await read(await post({ ask: 'a page' }));
    expect(failed(all)).toMatchObject({ code: 'NO_DOCUMENT' });
    expect(done(all)).toBeNull();
  });
});

describe('the upstream', () => {
  test('falls back to the second model, and refunds the first', async () => {
    answers = [
      () => new Response('nope', { status: 500 }),
      () => writes([PAGE]),
    ];
    const all = await read(await post({ ask: 'a lawn care page' }));

    expect(all[0]).toEqual({ t: 'accepted' });
    // The change of model in `thinking` is the only sign of the fallback.
    expect(
      all.filter((frame) => frame.t === 'thinking').map((frame) => frame.model),
    ).toEqual(['writer', 'second-writer']);
    expect(all.find((frame) => frame.t === 'start')).toEqual({
      t: 'start',
      model: 'second-writer',
    });
    expect(asked.map((seen) => seen.model)).toEqual([
      'writer',
      'second-writer',
    ]);
    // The deployment's fault is given back; only the page is billed tokens.
    expect(await spent()).toEqual({ requests: 1, tokens: 900 });
  });

  test('treats a model that only reasons as one that never answered', async () => {
    // Some models spend the whole ceiling reasoning and write nothing: nothing
    // is published, but the reasoning is charged.
    answers = [() => thinksOnly(), () => thinksOnly()];
    const answer = await post({ ask: 'a page' });
    expect(answer.status).toBe(200);
    const all = await read(answer);
    expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
    expect(done(all)).toBeNull();
    expect(asked).toHaveLength(2);
    expect(await spent()).toEqual({ requests: 2, tokens: 32000 });
  });

  test('bills nothing for a deployment fault, and hands the attempts back', async () => {
    // A key with no credit answers 401 to everything, which must neither bill
    // the ceiling nor close the day.
    answers = [
      () => new Response('no credit', { status: 401 }),
      () => new Response('down', { status: 503 }),
    ];
    const all = await read(await post({ ask: 'a page for my woodworking' }));
    expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
    expect(asked).toHaveLength(2);
    expect(await spent()).toEqual({ requests: 0, tokens: 0 });
  });

  test('hands the attempts back for a base URL this deployment got wrong', async () => {
    // The whole URL comes from `KTHX_AI_URL`, so a 404 is the operator's (this
    // upstream answers a wrong path with 404); a 429 is the plan's concurrency.
    for (const status of [404, 429]) {
      await kthx().sql`delete from build_usage where login = ${DAD}`;
      answers = [
        () => new Response('not here', { status }),
        () => new Response('not here', { status }),
      ];
      const all = await read(await post({ ask: 'a page for my woodworking' }));
      expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
      expect(asked).toHaveLength(2);
      expect(await spent()).toEqual({ requests: 0, tokens: 0 });
      asked = [];
    }
  });

  test('bills nothing for an upstream that answers with no stream at all', async () => {
    // The billing floor is for a body opened and left silent; none was opened.
    answers = [
      () => new Response(null, { status: 200 }),
      () => new Response(null, { status: 200 }),
    ];
    const all = await read(await post({ ask: 'a page' }));
    expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
    expect(asked).toHaveLength(2);
    expect(await spent()).toEqual({ requests: 0, tokens: 0 });
  });

  test('keeps the attempt when the refusal is about the body', async () => {
    // A refusal the caller's material earned stays spent: the day is the only
    // ceiling on outbound calls.
    answers = [
      () => new Response('context length', { status: 400 }),
      () => new Response('context length', { status: 400 }),
    ];
    const all = await read(await post({ ask: 'a page' }));
    expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
    expect(await spent()).toEqual({ requests: 2, tokens: 0 });
  });

  test('gives the slot back when the control database does not answer', async () => {
    // The in-flight slot is taken before the day is read, so a Postgres error
    // there must still release it.
    await kthx().sql`alter table build_usage rename to build_usage_gone`;
    const broken = await post({ ask: 'a page' });
    expect(broken.status).toBe(500);
    expect((await broken.json()).code).toBe('STORAGE_FAILURE');
    await kthx().sql`alter table build_usage_gone rename to build_usage`;

    answers = [() => writes([`<!-- kthx-name: after-the-blip -->\n${PAGE}`])];
    const after = done(await read(await post({ ask: 'a page' })));
    expect(after).toMatchObject({ name: 'after-the-blip' });
  });

  test('is not called at all once the day is spent', async () => {
    await kthx().sql`
      insert into build_usage (login, day, requests)
      values (${DAD}, ${utcDay()}, ${MAX_BUILD_REQUESTS_DAY})
    `;
    const refused = await post({ ask: 'a page' });
    expect(refused.status).toBe(429);
    expect((await refused.json()).code).toBe('AI_BUDGET');
    expect(refused.headers.get('retry-after')).not.toBeNull();
    expect(asked).toHaveLength(0);
  });
});

describe('the silence before a model writes', () => {
  test('is answered at once, and spoken through', async () => {
    // Quiet for 20 s, twice Bun's default idle timeout. A browser abandons a
    // silent `fetch`, so bytes must reach the client throughout.
    answers = [
      () => thinksFor(20_000, '<!-- kthx-name: patient -->\n', [PAGE]),
    ];
    const server = kthx().listen();
    const began = Date.now();
    const response = await fetch(`${server.url.origin}/api/build`, {
      method: 'POST',
      headers: {
        host: IDENTITY,
        'content-type': 'application/json',
        'tailscale-user-login': DAD,
      },
      body: JSON.stringify({ ask: 'a page for my woodworking' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/x-ndjson');

    // `fetch` resolves on headers, so the frames are timed as they arrive.
    const all: Record<string, unknown>[] = [];
    const at: number[] = [];
    for await (const landed of arriving(response)) {
      all.push(landed.frame);
      at.push(landed.at - began);
      if (landed.frame.t === 'done' || landed.frame.t === 'error') break;
    }

    // Before the shape checks, so a failure here reads as the wait it is.
    expect(at[0]).toBeLessThan(5_000);
    expect(all[0]).toEqual({ t: 'accepted' });
    const thinking = all.filter((frame) => frame.t === 'thinking');
    // One a second through the silence, each naming the busy model.
    expect(thinking.length).toBeGreaterThanOrEqual(10);
    expect(thinking.every((frame) => frame.model === 'writer')).toBe(true);
    expect(thinking.at(-1)?.ms).toBeGreaterThan(9_000);
    // The last arrived while the model was still silent, not in a final burst.
    const last = all.reduce(
      (found, frame, index) => (frame.t === 'thinking' ? index : found),
      -1,
    );
    expect(at[last]).toBeGreaterThan(15_000);
    // Not strictly less: a heartbeat and the first byte can share a tick.
    expect(at[last]).toBeLessThanOrEqual(at.at(-1) ?? 0);
    expect(done(all)).toMatchObject({ name: 'patient', document: PAGE });
  }, 60_000);

  test('ends in a frame, never in a status, however it ends', async () => {
    // Once the body streams there is no status left to refuse with, so both
    // models refusing still answers 200.
    answers = [
      () => new Response('down', { status: 503 }),
      () => new Response('down', { status: 503 }),
    ];
    const answer = await post({ ask: 'a page for my woodworking' });
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/x-ndjson');

    const all = await read(answer);
    expect(all[0]).toEqual({ t: 'accepted' });
    expect(
      all.filter((frame) => frame.t === 'thinking').map((frame) => frame.model),
    ).toEqual(['writer', 'second-writer']);
    // No model wrote a word, so no `start`; the last frame carries the code.
    expect(all.some((frame) => frame.t === 'start')).toBe(false);
    expect(done(all)).toBeNull();
    expect(all.at(-1)).toMatchObject({ t: 'error', code: 'AI_UPSTREAM' });
    expect(all.at(-1)?.message).toBeString();
    // A deployment fault costs the caller nothing.
    expect(await spent()).toEqual({ requests: 0, tokens: 0 });
  });
});

describe('a change', () => {
  test('is written on top of what the site is serving', async () => {
    const name = await claimAs(DAD, 'changing');
    await publish(DAD, name, [{ path: 'index.html', bytes: bytes(PAGE) }]);

    const changed = PAGE.replace('Boards', 'Green Boards');
    answers = [() => writes([`<!-- kthx-name: ignored -->\n${changed}`])];
    const last = done(
      await read(await post({ ask: 'make the heading green', site: name })),
    );

    // The model gets the live document; its proposed name is discarded.
    expect(asked[0]?.messages[1]?.content).toContain(PAGE);
    expect(last).toMatchObject({ site: name, name, document: changed });
    // A refine has no name to offer, so there is no availability to read.
    expect(last?.available).toBeNull();
  });

  test('publishes nothing when the answer is the same bytes', async () => {
    const name = await claimAs(DAD, 'samesame');
    await publish(DAD, name, [{ path: 'index.html', bytes: bytes(PAGE) }]);

    answers = [() => writes([PAGE])];
    const last = done(
      await read(await post({ ask: 'make it nicer', site: name })),
    );
    expect(last).toMatchObject({ unchanged: true, build: null, site: name });

    const [kept] = (await kthx().sql`
      select count(*)::int as drafts from builds
    `) as { drafts: number }[];
    expect(kept?.drafts).toBe(0);
  });

  test('is refused on a site this login does not open', async () => {
    const name = await claimAs(MOM, 'not-yours');
    await publish(MOM, name, [{ path: 'index.html', bytes: bytes(PAGE) }]);
    const refused = await post({ ask: 'change it', site: name });
    expect(refused.status).toBe(403);
    expect(asked).toHaveLength(0);
  });

  test('is refused when the page it would send back is too big to answer', async () => {
    // The answer's 512 KiB cap applies on the way in too, or one press could
    // read a 32 MiB release and post it once per model.
    const name = await claimAs(DAD, 'toobig');
    const huge = `<!doctype html><html><body>${'x'.repeat(600 * 1024)}</body></html>`;
    await publish(DAD, name, [{ path: 'index.html', bytes: bytes(huge) }]);
    const refused = await post({ ask: 'make it simpler', site: name });
    expect(refused.status).toBe(413);
    expect((await refused.json()).code).toBe('TOO_LARGE');
    expect(asked).toHaveLength(0);
  });

  test('is refused on a site that was not written here', async () => {
    // Two files means assets, which one published document would strand.
    const name = await claimAs(DAD, 'handmade');
    await publish(DAD, name, [
      { path: 'index.html', bytes: bytes(PAGE) },
      { path: 'photo.css', bytes: bytes('body{}') },
    ]);
    const refused = await post({ ask: 'change it', site: name });
    expect(refused.status).toBe(404);
    expect(asked).toHaveLength(0);
  });
});

describe('the connection', () => {
  test('outlives a model that thinks for forty seconds', async () => {
    // Bun's idle timeout is 10 s here and 30 s in production. Timed, not
    // mocked: a fake `server.timeout` would pass with seconds or milliseconds.
    answers = [
      () =>
        writesSlowly(20_000, 20_000, '<!-- kthx-name: patient -->\n', [PAGE]),
    ];
    const server = kthx().listen();
    const response = await fetch(`${server.url.origin}/api/build`, {
      method: 'POST',
      headers: {
        host: IDENTITY,
        'content-type': 'application/json',
        'tailscale-user-login': DAD,
      },
      body: JSON.stringify({ ask: 'a page for my woodworking' }),
    });
    expect(response.status).toBe(200);
    expect(done(await read(response))).toMatchObject({
      name: 'patient',
      document: PAGE,
    });
  }, 90_000);
});

describe('a caller who has gone away', () => {
  test('does not pay for the fallback model', async () => {
    // A closed socket must stop the fallback from a paid generation. Real
    // socket: the claim is about `request.signal`.
    answers = [
      () => thinksFor(3000, '<!-- kthx-name: nobody -->\n', [PAGE]),
      () => writes([PAGE]),
    ];
    const server = kthx().listen();
    const hangUp = new AbortController();
    const call = fetch(`${server.url.origin}/api/build`, {
      method: 'POST',
      headers: {
        host: IDENTITY,
        'content-type': 'application/json',
        'tailscale-user-login': DAD,
      },
      body: JSON.stringify({ ask: 'a page for my boats' }),
      signal: hangUp.signal,
    }).catch(() => null);
    await Bun.sleep(300);
    hangUp.abort();
    await call;
    await Bun.sleep(500);

    expect(asked.map((seen) => seen.model)).toEqual(['writer']);
    // A partial document is no page, so no draft is kept.
    const [row] = (await kthx().sql`
      select count(*)::int as drafts from builds
    `) as { drafts: number }[];
    expect(row?.drafts).toBe(0);
  }, 20_000);
});

describe('a base that is not there', () => {
  // RFC 5737 space routes nowhere, so a connect hangs as a wrong hostname does.
  const dead = withServer({
    identityHost: IDENTITY,
    tailnetProxies: [PROXY],
    aiUrl: 'http://192.0.2.1:9',
    aiKey: 'k',
    aiModel: 'writer',
    aiModels: ['writer', 'second-writer'],
    aiBuildModel: 'writer',
    aiBuildFallbackModel: 'second-writer',
  });

  test('says so in seconds, not in minutes', async () => {
    // Reaching the base runs on `HEADERS_MS`, not the thinking model's clock.
    const began = Date.now();
    const response = await dead().fetch(
      ask('/api/build', {
        host: IDENTITY,
        method: 'POST',
        headers: {
          'tailscale-user-login': DAD,
          origin: `https://${IDENTITY}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ask: 'a page for my woodworking' }),
      }),
      peer(PROXY),
    );
    // Still a frame on a 200: the socket is never what fails.
    expect(response.status).toBe(200);
    const frames = await read(response);
    expect(frames.at(-1)).toMatchObject({ t: 'error', code: 'AI_UPSTREAM' });

    // Two models, each on the short clock.
    const took = Date.now() - began;
    expect(took).toBeLessThan(2 * HEADERS_MS + 20_000);
  }, 120_000);
});

describe('the page every door serves', () => {
  test('carries the builder on the tailnet door, told who is reading it', async () => {
    const served = await ontailnet('/', DAD);
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain(` data-identity data-login="${DAD}"`);
    expect(html).toContain(`data-zone="${ZONE}"`);
    expect(html).toContain('What would you like a website for?');
  });

  test('says one sentence to a caller the tailnet did not name', async () => {
    const html = await (await ontailnet('/', null)).text();
    expect(html).toContain(' data-identity>');
    expect(html).not.toContain('data-login="');
    expect(html).toContain('needs your Tailscale login');
  });

  test('is one page, and the builder is on no door but that one', async () => {
    // The gate stays in the sheet, the other doors lack the attribute, and
    // they keep their own deck.
    const page = await Bun.file(LANDING_PATH).text();
    expect(page).toContain('#builder{display:none;');
    expect(page).toContain('html[data-identity] #builder{display:block}');
    for (const host of [ZONE, CONTROL]) {
      const html = await (
        await kthx().fetch(ask('/', { host }), peer(PROXY))
      ).text();
      // The tag only: the sheet names the attribute in the gate itself.
      const tag = /<html[^>]*>/.exec(html)?.[0] ?? '';
      expect(html).toContain('kthx.dev</title>');
      expect(tag).toContain(`data-zone="${ZONE}"`);
      expect(tag).not.toContain('data-identity');
      expect(html).toContain('<div class="deck">');
      expect(html).toContain('Select a name');
      expect(html).toContain('Drop a zip file or an index.html file');
    }
  });

  test('does not send the builder to a door that cannot use it', async () => {
    // Hiding it with a selector would still ship its markup and script to
    // every anonymous visitor.
    const onDoor = async (host: string) =>
      await (await kthx().fetch(ask('/', { host }), peer(PROXY))).text();

    const tailnet = await (await ontailnet('/', DAD)).text();
    for (const host of [ZONE, CONTROL]) {
      const html = await onDoor(host);
      for (const gone of [
        'id="builder"',
        'if (IDENTITY) (() => {',
        'html[data-identity] #builder{display:block}',
      ]) {
        expect(tailnet).toContain(gone);
        expect(html).not.toContain(gone);
      }
      expect(html).not.toContain('builder:start');
      expect(tailnet).not.toContain('builder:start');
      // A cut: much smaller, and still a whole page.
      expect(html.length).toBeLessThan(tailnet.length - 30_000);
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    }
  });
});

describe('the whole road, as the page walks it', () => {
  /** The page's own ZIP writer, lifted out, so the release route must read it. */
  async function pageZip(): Promise<(name: string, bytes: Uint8Array) => Blob> {
    const html = await Bun.file(LANDING_PATH).text();
    const from = html.indexOf('let crcTable;');
    const to = html.indexOf('/* upload */');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return new Function(`${html.slice(from, to)}; return zipOne;`)() as (
      name: string,
      bytes: Uint8Array,
    ) => Blob;
  }

  test('writes, claims, publishes, rolls back and changes it again', async () => {
    const zipOne = await pageZip();
    const name = kthx().name('road');

    answers = [() => writes([`<!-- kthx-name: ${name} -->\n${PAGE}`])];
    const first = done(await read(await post({ ask: 'a page for my boats' })));
    expect(first).toMatchObject({ name, available: true });

    // As the page does: claim, then publish through the release route.
    const claimed = await ontailnet('/api/sites', DAD, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    expect(claimed.status).toBe(201);
    const published = await ontailnet(`/api/sites/${name}/releases`, DAD, {
      method: 'POST',
      headers: { origin: `https://${IDENTITY}` },
      body: zipOne('index.html', bytes(first?.document as string)),
    });
    expect(published.status).toBe(201);
    const site = await kthx().fetch(ask('/', { host: `${name}.${ZONE}` }));
    expect(await site.text()).toBe(PAGE);

    // A rollback holds the site: later releases are stored but do not serve.
    const second = await ontailnet(`/api/sites/${name}/releases`, DAD, {
      method: 'POST',
      headers: { origin: `https://${IDENTITY}` },
      body: zipOne('index.html', bytes(PAGE.replace('Boards', 'Old Boards'))),
    });
    expect(second.status).toBe(201);
    const rolled = await ontailnet(`/api/sites/${name}/serve`, DAD, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ n: 1 }),
    });
    expect(await rolled.json()).toMatchObject({ serving: 1, held: true });

    const greener = PAGE.replace('Boards', 'Green Boards');
    answers = [() => writes([greener])];
    const changed = done(
      await read(await post({ ask: 'make the heading green', site: name })),
    );
    expect(changed).toMatchObject({ site: name, unchanged: false });

    const again = await ontailnet(`/api/sites/${name}/releases`, DAD, {
      method: 'POST',
      headers: { origin: `https://${IDENTITY}` },
      body: zipOne('index.html', bytes(changed?.document as string)),
    });
    const numbered = (await again.json()) as { n: number; serving: number };
    // Not serving, so publishing must take the hold off, as the page does next.
    expect(numbered.serving).not.toBe(numbered.n);
    expect(
      await (await kthx().fetch(ask('/', { host: `${name}.${ZONE}` }))).text(),
    ).toBe(PAGE);

    const released = await ontailnet(`/api/sites/${name}/hold`, DAD, {
      method: 'DELETE',
      headers: { origin: `https://${IDENTITY}` },
    });
    expect(released.status).toBe(200);
    expect(
      await (await kthx().fetch(ask('/', { host: `${name}.${ZONE}` }))).text(),
    ).toBe(greener);
  });
});

describe('the page, when the upload half of publishing fails', () => {
  /** The page's `api` helper, against this server. */
  function apiAs(login: string) {
    return async (
      method: string,
      path: string,
      init: { json?: unknown } = {},
    ): Promise<unknown> => {
      const response = await ontailnet(path, login, {
        method,
        headers:
          init.json === undefined
            ? {}
            : {
                'content-type': 'application/json',
                origin: `https://${IDENTITY}`,
              },
        body: init.json === undefined ? undefined : JSON.stringify(init.json),
      });
      if (response.status === 204) return null;
      const data = (await response.json().catch(() => ({}))) as {
        code?: string;
        message?: string;
      };
      if (!response.ok) {
        const refusal = new Error(data.message) as Error & {
          code?: string;
          status?: number;
        };
        refusal.code = data.code;
        refusal.status = response.status;
        throw refusal;
      }
      return data;
    };
  }

  /**
   * The page's own claim step, lifted out. A claim cannot be repeated, so the
   * page's retry is tested against this server.
   */
  async function pageClaim(api: ReturnType<typeof apiAs>): Promise<{
    claim: (name: string) => Promise<void>;
    claimedEmpty: (name: string) => Promise<boolean>;
  }> {
    const html = await Bun.file(LANDING_PATH).text();
    const from = html.indexOf('async function claim(');
    const to = html.indexOf('/* ---- screens');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    return new Function(
      'api',
      `${html.slice(from, to)}; return { claim, claimedEmpty };`,
    )(api) as {
      claim: (name: string) => Promise<void>;
      claimedEmpty: (name: string) => Promise<boolean>;
    };
  }

  test('finishes the claim it already made instead of taking a second name', async () => {
    const { claim } = await pageClaim(apiAs(DAD));
    const name = kthx().name('resume');

    await claim(name);
    // After a failed upload the second press comes back here, and his own
    // claim must not read as taken.
    await claim(name);

    await publish(DAD, name, [{ path: 'index.html', bytes: bytes(PAGE) }]);
    expect(
      await (await kthx().fetch(ask('/', { host: `${name}.${ZONE}` }))).text(),
    ).toBe(PAGE);
  });

  test('does not put a new page over one that is already online', async () => {
    const { claim } = await pageClaim(apiAs(DAD));
    const mine = await claimAs(DAD, 'standing');
    await publish(DAD, mine, [{ path: 'index.html', bytes: bytes(PAGE) }]);
    // His, with a page on it: a second press finishes, never overwrites.
    await expect(claim(mine)).rejects.toMatchObject({ code: 'TAKEN' });

    const hers = await claimAs(MOM, 'hers');
    await expect(claim(hers)).rejects.toMatchObject({ code: 'TAKEN' });
  });

  test('reads an unreachable server as neither taken nor free', async () => {
    const name = await claimAs(DAD, 'unreachable');
    expect(await (await pageClaim(apiAs(DAD))).claimedEmpty(name)).toBe(true);

    // A check that never arrived must not answer "not yours": a rejection
    // with no status is rethrown.
    const offline = await pageClaim(() => {
      throw Object.assign(new Error('offline'), { code: 'OFFLINE' });
    });
    await expect(offline.claimedEmpty(name)).rejects.toMatchObject({
      code: 'OFFLINE',
    });
    await expect(offline.claim(name)).rejects.toMatchObject({
      code: 'OFFLINE',
    });
  });
});

/** Just enough of a document for these screens; this file has no DOM. */
interface Node {
  textContent: string;
  value: string;
  hidden: boolean;
  disabled: boolean;
  className: string;
  onclick?: () => void;
  children: Node[];
  append: (...kids: Node[]) => void;
  replaceChildren: (...kids: Node[]) => void;
  [key: string]: unknown;
}
function node(): Node {
  const made: Node = {
    textContent: '',
    value: '',
    hidden: false,
    disabled: false,
    className: '',
    style: {},
    children: [],
    focus: () => undefined,
    append: (...kids: Node[]) => {
      made.children.push(...kids);
    },
    replaceChildren: (...kids: Node[]) => {
      made.children = kids;
    },
  };
  return made;
}
function screen(values: Record<string, string> = {}) {
  const made = new Map<string, Node>();
  const $ = (selector: string): Node => {
    const id = selector.replace('#', '');
    let el = made.get(id);
    if (el === undefined) {
      el = node();
      el.value = values[id] ?? '';
      made.set(id, el);
    }
    return el;
  };
  return { $, el: (id: string) => $(`#${id}`) };
}

describe('every refusal this page can meet has a sentence', () => {
  interface Says {
    SAYS: { UNKNOWN: string } & Record<string, string | undefined>;
    GOOD: Set<string>;
    BEFORE_CHANGING: Record<string, string>;
    sentence: (err: unknown, also?: Record<string, string>) => string;
    /** Renders into a stub box and returns its class and text. */
    render: (err: unknown) => { className: string; text: string };
  }

  /** The page's copy table, lookup and message box, lifted out. */
  async function pageSays(): Promise<Says> {
    const html = await Bun.file(LANDING_PATH).text();
    const from = html.indexOf('const SAYS = {');
    const to = html.indexOf('/** `fetch`, with a dropped connection');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const box = node();
    const lifted = new Function(
      '$',
      'document',
      `${html.slice(from, to)}; return { SAYS, GOOD, BEFORE_CHANGING, sentence, oops };`,
    )(() => box, { createElement: node }) as Omit<Says, 'render'> & {
      oops: (where: string, err: unknown, lead?: string) => void;
    };
    return {
      ...lifted,
      render: (err: unknown) => {
        lifted.oops('#anywhere', err, 'lead');
        const made = box.children[0] as Node;
        return {
          className: made.className,
          text: made.children.map((kid) => kid.textContent).join(' '),
        };
      },
    };
  }

  test('covers every code the routes it calls can refuse with', async () => {
    const { SAYS } = await pageSays();
    // Every code the routes this page calls can answer with.
    for (const code of [
      'AI_BUDGET',
      'AI_UPSTREAM',
      'BUSY',
      'FORBIDDEN',
      'GONE',
      'INVALID_NAME',
      'MALFORMED_REQUEST',
      'NOT_FOUND',
      'NO_DOCUMENT',
      'RATE_LIMITED',
      'RESERVED',
      'STORAGE_FAILURE',
      'TAKEN',
      'TIMEOUT',
      'TOO_LARGE',
      'UNAUTHENTICATED',
    ]) {
      expect(SAYS[code]).toBeString();
    }
  });

  test('never shows the browser its own English, or the server its own', async () => {
    const { SAYS, sentence } = await pageSays();
    // A dropped connection on a phone: no code, and a message never shown.
    expect(sentence(new TypeError('Load failed'))).toBe(SAYS.UNKNOWN);
    expect(sentence({ code: 'SITE_FULL', message: 'this site is full' })).toBe(
      SAYS.UNKNOWN,
    );
    expect(sentence(undefined)).toBe(SAYS.UNKNOWN);
    for (const say of Object.values(SAYS)) {
      expect(say).not.toMatch(/[0-9]{3}|release|token|bearer|endpoint/i);
    }
  });

  test('does not say good news in the colour kept for bad', async () => {
    const { SAYS, render } = await pageSays();
    // Reassurances, so never the red box kept for failures.
    for (const code of ['PICKED_UP', 'CLAIMED', 'TYPED_BACK', 'PINNED']) {
      expect(SAYS[code]).toBeString();
      const shown = render({ code });
      expect(shown.className).toContain('note');
      expect(shown.text).toContain(String(SAYS[code]));
    }
    for (const code of ['TAKEN', 'AI_UPSTREAM', 'OFFLINE', 'UNCHANGED']) {
      expect(render({ code }).className).not.toContain('note');
    }
  });

  test('does not send him round a circle no smaller change gets out of', async () => {
    const { BEFORE_CHANGING, sentence } = await pageSays();
    // The serving page is too big before any model is asked, so a smaller
    // change cannot help.
    const said = sentence({ code: 'TOO_LARGE', status: 413 }, BEFORE_CHANGING);
    expect(said).not.toMatch(/came back|smaller change/i);
    expect(said).toBeString();
  });
});

/**
 * A span of the page's script between two markers. The deck shares the page,
 * so each marker must be one only the builder has.
 */
async function slice(from: string, to: string): Promise<string> {
  const html = await Bun.file(LANDING_PATH).text();
  const start = html.indexOf(from);
  const end = html.indexOf(to);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return html.slice(start, end);
}

describe('an address of his own, on the screens that offer it', () => {
  test('is offered as his own, and not as somebody else’s', async () => {
    const src = await slice('function propose(done)', '/**\n * The proposal');
    const said: { code: string | null; lead: string }[] = [];
    const propose = new Function(
      'pinned',
      'draft',
      'typed',
      'proposal',
      'hostOf',
      `let held = null; ${src} return (done) => { propose(done); return held; };`,
    )(
      null,
      () => undefined,
      () => undefined,
      (err: { code: string } | null, lead: string) =>
        said.push({ code: err?.code ?? null, lead }),
      (name: string) => `${name}.${ZONE}`,
    ) as (done: Record<string, unknown>) => Record<string, unknown>;

    const frame = {
      build: 'b1',
      name: 'dartmouth-boards',
      site: null,
      document: PAGE,
    };
    // Nobody's: the ordinary case.
    expect(propose({ ...frame, available: true, yours: null })).toMatchObject({
      taken: false,
    });
    expect(said.at(-1)).toEqual({ code: null, lead: expect.any(String) });

    // His, with nothing on it: a stranded claim the green button finishes.
    expect(
      propose({ ...frame, available: false, yours: 'empty' }),
    ).toMatchObject({ taken: false, yours: 'empty' });
    expect(said.at(-1)?.code).toBe('CLAIMED');

    // His, with a website on it: needs another name, but is not someone else's.
    expect(
      propose({ ...frame, available: false, yours: 'live' }),
    ).toMatchObject({ taken: true, yours: 'live' });
    expect(said.at(-1)?.code).toBe('YOURS');
    expect(said.at(-1)?.lead).toContain('already your website');

    // Somebody else's: the only case that is taken.
    expect(propose({ ...frame, available: false, yours: null })).toMatchObject({
      taken: true,
    });
    expect(said.at(-1)?.code).toBe('TAKEN');
  });

  test('is on the list, with the one thing left to do with it', async () => {
    // Nothing reclaims a claim with no release, so "your websites" lists it.
    const src = await slice('/**\n * Every address of his', '/* ---- the wait');
    const page = screen();
    const list = new Function(
      '$',
      'document',
      'api',
      'hostOf',
      'ago',
      'askChange',
      'draft',
      'typed',
      'typedBack',
      'oops',
      'show',
      `let held = null; let pinned = null;
       ${src}
       return { listMine, usePinned, pinnedNow: () => pinned };`,
    )(
      page.$,
      { createElement: node },
      async () => ({
        items: [
          { name: 'stranded', url: 'x', serving: null, releases: 0 },
          {
            name: 'published',
            url: 'y',
            serving: 1,
            releases: 1,
            changed: null,
          },
        ],
      }),
      (name: string) => `${name}.${ZONE}`,
      () => 'changed today',
      () => undefined,
      () => undefined,
      () => undefined,
      () => ({ ask: 'the sentence he typed' }),
      () => undefined,
      () => undefined,
    ) as {
      listMine: () => Promise<void>;
      usePinned: (name: string) => void;
      pinnedNow: () => string | null;
    };

    await list.listMine();
    const rows = page.el('b-minelist').children;
    expect(rows).toHaveLength(2);
    const stranded = rows[0]?.children ?? [];
    expect(stranded[0]?.textContent).toBe(`stranded.${ZONE}`);
    const acts = stranded[2]?.children ?? [];
    expect(acts).toHaveLength(1);
    expect(acts[0]?.textContent).toBe('Put a page on it');

    // Pressing it pins the next page to that address.
    acts[0]?.onclick?.();
    expect(list.pinnedNow()).toBe('stranded');
  });

  test('the address he picks does not cost him the sentence he typed', async () => {
    // The tap usually follows typing into the box below, so picking an address
    // keeps the sentence.
    const src = await slice('/**\n * Every address of his', '/* ---- the wait');
    const page = screen();
    const ask = page.el('b-ask');
    const lifted = new Function(
      '$',
      'document',
      'api',
      'hostOf',
      'ago',
      'askChange',
      'draft',
      'typed',
      'typedBack',
      'oops',
      'show',
      `let held = null; let pinned = null;
       ${src}
       return { usePinned };`,
    )(
      page.$,
      { createElement: node },
      async () => ({ items: [] }),
      (name: string) => `${name}.${ZONE}`,
      () => 'changed today',
      () => undefined,
      () => {
        throw new Error('the draft is not this button to discard');
      },
      () => {
        throw new Error('the backup is not this button to discard');
      },
      () => ({ ask: 'a page for my woodworking' }),
      () => undefined,
      () => undefined,
    ) as { usePinned: (name: string) => void };

    ask.value = 'cutting boards and birdhouses in Dartmouth';
    lifted.usePinned('stranded');
    expect(ask.value).toBe('cutting boards and birdhouses in Dartmouth');

    // A box a reload emptied is refilled from the backup.
    ask.value = '';
    lifted.usePinned('stranded');
    expect(ask.value).toBe('a page for my woodworking');
  });

  test('leaves the name screen with something he can press', async () => {
    // Opened on a name that is not free, the green button starts disabled, so
    // the other must stay live.
    const src = await slice('function startNaming(', 'function nameVerdict(');
    const page = screen();
    const startNaming = new Function(
      '$',
      'held',
      'hostOf',
      'paintName',
      'show',
      `${src} return startNaming;`,
    )(
      page.$,
      { name: 'taken-one', yours: null },
      (name: string) => `${name}.${ZONE}`,
      () => undefined,
      () => undefined,
    ) as (pushed?: string) => void;

    startNaming('taken-one');
    expect(page.el('b-keepname').hidden).toBe(false);
    expect(page.el('b-keepname').textContent).toBeTruthy();
    expect(page.el('b-namingsay').textContent).not.toContain('somebody else');
    expect(page.el('b-name').value).toBe('taken-one');

    startNaming();
    expect(page.el('b-keepname').hidden).toBe(false);
  });

  test('is usable on the name screen when it is his and empty', async () => {
    const src = await slice('function paintName()', '/* ---- what the buttons');
    const answers: Record<string, unknown>[] = [];
    const page = screen({ 'b-name': 'his-own' });
    const verdicts: { say: string; kind?: string }[] = [];
    const paintName = new Function(
      '$',
      'urlOf',
      'nameVerdict',
      'api',
      `let checking = null; ${src} return paintName;`,
    )(
      page.$,
      (name: string) => `https://${name}.${ZONE}`,
      (say: string, kind?: string) => verdicts.push({ say, kind }),
      async () => answers.shift() ?? {},
    ) as () => void;

    // Typing the stranded address back is the only way to it once the draft
    // is gone, so it must not read as taken.
    answers.push({ available: false, why: 'TAKEN', yours: 'empty' });
    paintName();
    await Bun.sleep(400);
    expect(page.el('b-usename').disabled).toBe(false);
    expect(verdicts.at(-1)?.kind).toBe('yes');
    expect(verdicts.at(-1)?.say).not.toContain('Somebody');

    // A website of his is not usable here, and the sentence says why.
    answers.push({ available: false, why: 'TAKEN', yours: 'live' });
    paintName();
    await Bun.sleep(400);
    expect(page.el('b-usename').disabled).toBe(true);
    expect(verdicts.at(-1)?.say).toContain('your website');

    answers.push({ available: false, why: 'TAKEN', yours: null });
    paintName();
    await Bun.sleep(400);
    expect(page.el('b-usename').disabled).toBe(true);
    expect(verdicts.at(-1)?.say).not.toContain('Somebody');
  });
});

describe('the wait, now that the server talks through it', () => {
  /** The wait screen and the frame reader, lifted together. */
  async function walk(frames: string[]): Promise<{
    done: Record<string, unknown> | null;
    refused: string | null;
    screens: { say: string; count: string }[];
  }> {
    const src = await slice('/* ---- the wait', '/* ---- publishing');
    const said: Record<string, string> = {};
    const screens: { say: string; count: string }[] = [];
    const el = (id: string) => ({
      set textContent(value: string) {
        said[id] = value;
      },
      get textContent() {
        return said[id] ?? '';
      },
    });
    let at = 0;
    const reader = {
      async read(): Promise<{ done: boolean; value?: Uint8Array }> {
        // One read late: the screen as it stood after the previous frame, which
        // is what a person sees.
        if (at > 0) {
          screens.push({
            say: said['#b-say'] ?? '',
            count: said['#b-count'] ?? '',
          });
        }
        if (at >= frames.length) return { done: true };
        return {
          done: false,
          value: new TextEncoder().encode(`${frames[at++]}\n`),
        };
      },
    };
    const build = new Function(
      '$',
      'show',
      'reach',
      'fault',
      `${src}; return build;`,
    )(
      el,
      () => undefined,
      async () => ({ ok: true, body: { getReader: () => reader } }),
      (code: string) => Object.assign(new Error(code), { code }),
    ) as (ask: string, site: string | null) => Promise<Record<string, unknown>>;
    let refused: string | null = null;
    const done = await build('a page for my boats', null).catch(
      (err: { code?: string }) => {
        refused = err.code ?? null;
        return null;
      },
    );
    return { done, refused, screens };
  }

  test('counts the server’s clock rather than this phone’s', async () => {
    // A throttled background tab cannot count, so `ms` is the server's.
    const { screens } = await walk([
      '{"t":"accepted"}',
      '{"t":"thinking","model":"writer","ms":0}',
      '{"t":"thinking","model":"writer","ms":40000}',
    ]);
    expect(screens[1]?.count).toBe('0 seconds so far');
    expect(screens[1]?.say).toContain('thinking');
    expect(screens[2]?.count).toBe('40 seconds so far');
  });

  test('says the fallback happened, which nothing else says', async () => {
    // A change of model between `thinking` frames is the only fallback signal.
    const { screens } = await walk([
      '{"t":"accepted"}',
      '{"t":"thinking","model":"writer","ms":0}',
      '{"t":"thinking","model":"second-writer","ms":95000}',
    ]);
    expect(screens[2]?.say).toContain('did not answer');
    expect(screens[2]?.count).toBe('95 seconds so far');
  });

  test('turns from seconds into characters when the first word lands', async () => {
    const { done, screens } = await walk([
      '{"t":"accepted"}',
      '{"t":"thinking","model":"writer","ms":0}',
      '{"t":"start","model":"writer"}',
      '{"t":"writing","chars":2140}',
      `{"t":"done","build":"b1","name":"boats","document":${JSON.stringify(PAGE)}}`,
    ]);
    expect(screens[2]?.say).toContain('started writing');
    expect(screens[3]?.count).toBe('2,140 characters so far');
    expect(done).toMatchObject({ name: 'boats', document: PAGE });
  });

  test('reads a refusal that arrives as a frame as a refusal', async () => {
    // Upstream refusals arrive only as frames in a 200.
    const { done, refused } = await walk([
      '{"t":"accepted"}',
      '{"t":"thinking","model":"writer","ms":0}',
      '{"t":"error","code":"AI_UPSTREAM","message":"the ai upstream did not answer"}',
    ]);
    expect(done).toBeNull();
    expect(refused).toBe('AI_UPSTREAM');
  });

  test('reads a body that ends without either as a connection that went', async () => {
    const { refused } = await walk(['{"t":"accepted"}']);
    expect(refused).toBe('CUT_OFF');
  });
});

describe('what an answer is read as', () => {
  test('takes the document out of whatever surrounds it', () => {
    expect(documentIn(`chatter\n${PAGE}\n\`\`\``)).toBe(PAGE);
    expect(documentIn('<!DOCTYPE HTML><html></html>')).toBe(
      '<!DOCTYPE HTML><html></html>',
    );
    expect(documentIn('no page here')).toBe('NO_DOCUMENT');
    expect(documentIn('<!doctype html><html>')).toBe('NO_DOCUMENT');
    // Refused whole: half a document is a broken page that looks published.
    const huge = `<!doctype html><html>${'x'.repeat(600 * 1024)}</html>`;
    expect(documentIn(huge)).toBe('TOO_LARGE');
  });

  test('takes the proposed name only when a claim would take it too', () => {
    expect(nameIn('<!-- kthx-name: lunenburg-charter -->\nx', 'boats')).toBe(
      'lunenburg-charter',
    );
    expect(nameIn('<!-- kthx-name: NOT A NAME -->\nx', 'my curling club')).toBe(
      'my-curling-club',
    );
    expect(nameIn('no comment at all', 'Ada’s 7th birthday')).toBe(
      'ada-s-7th-birthday',
    );
  });

  test('makes a name out of a sentence without slicing a word in half', () => {
    const long = slugOf(
      'A page for my woodworking, I make cutting boards and small furniture',
    );
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long).toBe('a-page-for-my-woodworking-i-make-cutting');
    // A sentence with nothing nameable still produces a name.
    expect(slugOf('!!!')).toMatch(/^site-[0-9a-f]{8}$/);
    expect(slugOf('admin')).toMatch(/^site-[0-9a-f]{8}$/);
  });
});

describe('the config', () => {
  const env = {
    DATABASE_URL: 'postgres://x',
    KTHX_ME_KEY: 'k'.repeat(32),
    KTHX_PG_KEY: 'p'.repeat(32),
    KTHX_AI_MODEL: 'chat-model',
    KTHX_AI_MODELS: 'chat-model,writer',
  };

  test('refuses a build model the allow-list does not name', () => {
    expect(() =>
      readConfig({ ...env, KTHX_AI_BUILD_MODEL: 'unlisted' }),
    ).toThrow('build model unlisted is not one of KTHX_AI_MODELS');
    expect(() =>
      readConfig({ ...env, KTHX_AI_BUILD_FALLBACK_MODEL: 'unlisted' }),
    ).toThrow('build model unlisted is not one of KTHX_AI_MODELS');
  });

  test('falls back to the chat model and no second attempt', () => {
    const read = readConfig(env);
    expect(read.aiBuildModel).toBe('chat-model');
    expect(read.aiBuildFallbackModel).toBeNull();
    // The build ceiling defaults to the public one.
    expect(read.aiBuildMaxTokens).toBe(read.aiMaxTokens);
  });
});
