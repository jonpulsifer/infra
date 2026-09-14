/**
 * `POST /api/build`: which door has it, what is not trusted about an answer,
 * and what it costs.
 *
 * A real stub upstream that really streams, because every interesting claim
 * here is about time and framing rather than about a return value: the response
 * opens when the request is accepted, it says something every second the model
 * is quiet, and a model that thinks for forty seconds must not be cut off by a
 * connection timeout nobody sees fire.
 *
 * **A stub that answers instantly cannot fail on any of that**, which is how a
 * route that held its response for 71-95 s of empty socket passed this file all
 * the way into somebody's hands. So the stubs here are slow on purpose and the
 * assertions are timed: {@link thinksFor} and {@link writesSlowly} are the two
 * that can still fail, and {@link arriving} is what reads a body while it is
 * still arriving rather than after it has stopped.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { LANDING_PATH } from '@repo/kthx/assets';
import { tarGz } from '../../cli/tar.ts';
import { utcDay } from '../../server/ai.ts';
import {
  documentIn,
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

/** The upstream, near enough: it records what it was asked and answers in turn. */
const upstream = Bun.serve({
  port: 0,
  // A model that thinks for forty seconds is the point of one of these tests,
  // and Bun's own default would cut the stub before the server under test ever
  // got the chance to.
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
  // The loopback peers as well, because the one test that needs a real socket
  // arrives over it and would otherwise be a caller nobody vouches for.
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
 * A model that thinks, writes a word, thinks again, then finishes.
 *
 * Both halves of a real generation, because the socket goes quiet in two
 * different ways: before the first content byte, where the route has nothing to
 * report but that it is waiting, and after it, where the route is a slow
 * response body. Bun's idle timer treats those differently, and the route has
 * to survive both.
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
 * A model that thinks for a while before its first word.
 *
 * Written to survive being hung up on: the enqueue after the sleep lands on a
 * stream the server under test has already cancelled, and an unguarded one
 * would fail the run from inside this stub rather than inside a test.
 */
function thinksFor(
  ms: number,
  first: string,
  rest: readonly string[],
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
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
        // Nobody is reading this any more, which is the point of the test.
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
 * Every frame as it lands, with the millisecond it landed on.
 *
 * The whole defect was invisible to a test that reads a response to the end and
 * then looks at it: a body that arrives all at once at ninety seconds and one
 * that arrives a line at a time from the first millisecond are the same array
 * afterwards, and only the second one is a page somebody sees.
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

/** Every frame of an ndjson answer, in order. */
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

/**
 * What this login has spent today.
 *
 * Slept on first: `bill` and `refundRequest` are `void ctx.sql…` — the answer
 * is not held for them, because a ledger write that failed costs the operator
 * money and the caller nothing — so a test that reads the row the moment the
 * response lands reads it before they arrive.
 */
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

    // The response is open before a model has been asked anything, and it names
    // the one it is waiting on until that model's first word arrives.
    expect(all[0]).toEqual({ t: 'accepted' });
    expect(all[1]).toMatchObject({ t: 'thinking', model: 'writer' });
    expect(all.find((frame) => frame.t === 'start')).toEqual({
      t: 'start',
      model: 'writer',
    });
    // Progress, not a spinner: the page says how much has been written.
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

    // What the upstream was asked for, which is not what the caller sent.
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
    // Measured: the fallback model dropped the comment on one prompt in six.
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
    // The model proposes from the description, so asking twice about the same
    // business proposes the same name — measured, every time. Told that address
    // was taken, he renamed, and the first name, its database and its role were
    // spent for nothing.
    const empty = await claimAs(DAD, 'his-own');
    answers = [() => writes([`<!-- kthx-name: ${empty} -->\n${PAGE}`])];
    expect(
      done(await read(await post({ ask: 'my woodworking' }))),
    ).toMatchObject({ name: empty, available: false, yours: 'empty' });

    // And a website of his is not the same answer as a claim of his: one is
    // finished by pressing the green button, the other needs its own name.
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
    // The fallback used to run behind a held response, so the page had only its
    // own clock to fill that silence with. It runs on an open one now, and the
    // model named in `thinking` changing is the whole of the signal.
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
    // Two attempts, one of them this deployment's fault and given back — and
    // only the one that wrote a page is billed any tokens.
    expect(await spent()).toEqual({ requests: 1, tokens: 900 });
  });

  test('treats a model that only reasons as one that never answered', async () => {
    // Measured: four models on this base spend the whole ceiling reasoning and
    // emit no content at all. Nothing was written, so nothing may be published
    // — but it answered, and what it spent reasoning is charged.
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
    // The state production was in for weeks: a key with no credit answers 401
    // to everything. Billing the token ceiling on a path where usage never
    // arrived charged sixteen thousand tokens an attempt for an outage nobody
    // asked for, and thirty-one presses of a button that wrote no page at all
    // closed the day until UTC midnight.
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
    // Unlike `/api/ai`, this route composes the whole URL out of `KTHX_AI_URL`
    // — the caller cannot pick a path — so a 404 is only ever the operator's,
    // and measured, a wrong path on this upstream answers 404 with a marketing
    // page rather than a 5xx. Thirty presses against one would otherwise close
    // a day in which nobody wrote a page, and then go on refusing after the URL
    // was fixed. A 429 is the plan's concurrency, which is nobody's sentence.
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
    // The floor is for an upstream that opened a body and said nothing through
    // it. Nothing was opened here, on a URL and a model that are both this
    // deployment's, so charging the ceiling *and* keeping the attempt is that
    // rule applied backwards: two presses would cost a day's worth of tokens
    // for two generations that never started.
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
    // The other half of the same rule, and the half `/api/ai` was hardened to
    // after it was found live: a refusal the caller's own material earned is
    // free to ask for again, and the day is the only ceiling on outbound calls
    // there is.
    answers = [
      () => new Response('context length', { status: 400 }),
      () => new Response('context length', { status: 400 }),
    ];
    const all = await read(await post({ ask: 'a page' }));
    expect(failed(all)).toMatchObject({ code: 'AI_UPSTREAM' });
    expect(await spent()).toEqual({ requests: 2, tokens: 0 });
  });

  test('gives the slot back when the control database does not answer', async () => {
    // The day is read before the response opens — it is the last thing here
    // that can still be a status — and an ordinary CNPG blip rejects that
    // await. The in-flight slot is taken before it: released on the paths that
    // return and not on the one that throws, a single Postgres error left this
    // login reading "one at a time" for the life of the pod, and four of them
    // closed the builder for everybody on the tailnet.
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
    // The defect this file could not see, and the reason it could not. Every
    // other stub here answers in microseconds, so the response always arrived
    // before anything could give up on it, and the 71-95 s of empty socket
    // production measured — twice, against the real model — was invisible from
    // in here. A browser abandons a `fetch` long before ninety seconds and
    // rejects it with a sentence of its own making: "Load failed", which is
    // what was on the screen.
    //
    // This stub is quiet for twenty seconds, twice Bun's default idle timeout,
    // and the claim is that bytes reach the client all the way through it.
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

    // The status on its own proves nothing — `fetch` resolves on headers — so
    // the frames are read as they land and timed against the model's silence.
    const all: Record<string, unknown>[] = [];
    const at: number[] = [];
    for await (const landed of arriving(response)) {
      all.push(landed.frame);
      at.push(landed.at - began);
      if (landed.frame.t === 'done' || landed.frame.t === 'error') break;
    }

    // The assertion that would have caught it: a first byte while the model is
    // twenty seconds from writing one. Asserted before the frame's shape so a
    // failure here reads as the wait it is rather than as a renamed field.
    expect(at[0]).toBeLessThan(5_000);
    expect(all[0]).toEqual({ t: 'accepted' });
    const thinking = all.filter((frame) => frame.t === 'thinking');
    // One a second through a twenty-second silence, every one of them naming
    // the model that is busy — a reasoning model is working, not idle, and the
    // page is now able to say so instead of spinning.
    expect(thinking.length).toBeGreaterThanOrEqual(10);
    expect(thinking.every((frame) => frame.model === 'writer')).toBe(true);
    expect(thinking.at(-1)?.ms).toBeGreaterThan(9_000);
    // And they were not one burst at the end: the last of them landed while the
    // model was still silent, which is the only reason the wait is countable.
    const last = all.reduce(
      (found, frame, index) => (frame.t === 'thinking' ? index : found),
      -1,
    );
    expect(at[last]).toBeGreaterThan(15_000);
    // Not strictly less than the last frame of all: the model's first byte and
    // a heartbeat tick can land in the same millisecond, and a test that fails
    // one run in two hundred on a coincidence teaches people to re-run it.
    expect(at[last]).toBeLessThanOrEqual(at.at(-1) ?? 0);
    // The page still arrives, which is the other half of the bargain.
    expect(done(all)).toMatchObject({ name: 'patient', document: PAGE });
  }, 60_000);

  test('ends in a frame, never in a status, however it ends', async () => {
    // Moving where a request is accepted moves every upstream fault with it:
    // once the body is a stream there is no status left to refuse with, so a
    // page that reads a code has to find one in the frames. Both models refuse
    // outright, and the answer is still 200.
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
    // No model wrote a word, so there is no `start` and nothing to publish —
    // and the last frame carries the same code and the same fixed sentence the
    // 502 used to carry in a body nobody was left to read.
    expect(all.some((frame) => frame.t === 'start')).toBe(false);
    expect(done(all)).toBeNull();
    expect(all.at(-1)).toMatchObject({ t: 'error', code: 'AI_UPSTREAM' });
    expect(all.at(-1)?.message).toBeString();
    // It is still this deployment's fault, so it still costs him nothing.
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

    // The document the model was handed is the one that is live, and the name
    // it proposed is discarded: this site already has one.
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
    // The answer is capped at 512 KiB on the way out; the release route takes
    // 32 MiB unpacked, so without the same cap on the way in one press of
    // "Change it" reads thirty megabytes into this pod and posts it to the
    // upstream once per model.
    const name = await claimAs(DAD, 'toobig');
    const huge = `<!doctype html><html><body>${'x'.repeat(600 * 1024)}</body></html>`;
    await publish(DAD, name, [{ path: 'index.html', bytes: bytes(huge) }]);
    const refused = await post({ ask: 'make it simpler', site: name });
    expect(refused.status).toBe(413);
    expect((await refused.json()).code).toBe('TOO_LARGE');
    expect(asked).toHaveLength(0);
  });

  test('is refused on a site that was not written here', async () => {
    // Two files means assets, and publishing one document over them would leave
    // every image of that site in a release nobody is looking at.
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
    // Bun closes a connection that has sent nothing for its idle timeout —
    // 30 s in production, Bun's own 10 s here, both of them far under the
    // 30-150 s a measured generation takes. The heartbeat is what keeps this
    // socket busy now and `server.timeout` is the belt behind it, so this walks
    // the whole road with a twenty-second think *and* a twenty-second gap
    // mid-document, which is the half no frame-counting test reaches. Timed
    // rather than mocked: `server.timeout` is a fact about a socket, and a fake
    // that records the call would pass with the argument in seconds or in
    // milliseconds.
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
    // Measured before this existed: abort 300 ms into the primary's think time
    // and the fallback ran a whole paid generation, streaming a document into a
    // response nothing was reading — on the surface where a 30-150 s wait is
    // exactly when a phone gets backgrounded. Over a real socket, because the
    // claim is about what a closed connection does to `request.signal`.
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
    // Nothing was written, so there is no draft: a partial document is not a
    // page, and the generation stops when the socket does.
    const [row] = (await kthx().sql`
      select count(*)::int as drafts from builds
    `) as { drafts: number }[];
    expect(row?.drafts).toBe(0);
  }, 20_000);
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
    // The landing page's breakage is what reverted a ticket once, and folding
    // the builder into it is exactly the kind of change that does it again. So
    // the assertion is on both halves: the attribute is absent on the other
    // two doors, the gate that reads it is still in the sheet — nothing is
    // rendered rather than something being hidden after the fact — and the
    // furniture those doors had yesterday is still where it was.
    const page = await Bun.file(LANDING_PATH).text();
    expect(page).toContain('#builder{display:none;');
    expect(page).toContain('html[data-identity] #builder{display:block}');
    for (const host of [ZONE, CONTROL]) {
      const html = await (
        await kthx().fetch(ask('/', { host }), peer(PROXY))
      ).text();
      // The tag, not the file: the sheet inside it names the attribute in the
      // gate itself, and a bare search of the body would find that and read as
      // a door this caller is not on.
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
    // Hiding it with a selector still shipped the markup, its rules and
    // thirty-five kilobytes of its script to every anonymous visitor on the
    // public apex — who has no `POST /api/build` to reach and nobody to be.
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
      // The fence itself never reaches a browser either.
      expect(html).not.toContain('builder:start');
      expect(tailnet).not.toContain('builder:start');
      // And it is a cut, not a rewrite: the page is meaningfully smaller and
      // still ends where a page ends.
      expect(html.length).toBeLessThan(tailnet.length - 30_000);
      expect(html.trimEnd().endsWith('</html>')).toBe(true);
    }
  });
});

describe('the whole road, as the page walks it', () => {
  /**
   * The page's own ZIP writer, lifted out of the file it lives in.
   *
   * It is twenty lines of hand-written ZIP that nothing else in this repo
   * parses until an upload arrives, so the assertion worth having is that the
   * release route reads what that page writes. One writer for both the deck
   * and the builder, now that they are one file: a second copy is a second
   * thing to get wrong.
   */
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

    // What the page does with a confirmed name: claim, then publish the
    // document through the ordinary release route, in a zip it wrote itself.
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

    // A second release, and then a rollback off it — which is what puts the
    // latch on: every release after a rollback is stored and none of them
    // serves until the hold comes off.
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
    // Stored, numbered, and NOT serving — so publishing a change has to take
    // the hold off, which is exactly what the page does next.
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
  /** The page's `api`, as the browser's one behaves, against this server. */
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
   * The page's own claim step, lifted out of the file it lives in.
   *
   * Claiming is the one step on that road which cannot be repeated — it makes a
   * real database and a kthx name is taken for good — so what the page does
   * when it is asked to claim twice is a claim about this server's answers, and
   * belongs against this server rather than against a mock of it.
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
    // The upload is what failed — a tailnet blip, a pod rolling under a merge —
    // and the second press comes back through here. Before, the claim ran
    // again, his own row conflicted, and the page told him the address he had
    // just taken belonged to somebody else.
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
    // His, but with a page on it: pressing the button twice means "finish
    // this", never "write over the one I made last week".
    await expect(claim(mine)).rejects.toMatchObject({ code: 'TAKEN' });

    const hers = await claimAs(MOM, 'hers');
    await expect(claim(hers)).rejects.toMatchObject({ code: 'TAKEN' });
  });

  test('reads an unreachable server as neither taken nor free', async () => {
    const name = await claimAs(DAD, 'unreachable');
    expect(await (await pageClaim(apiAs(DAD))).claimedEmpty(name)).toBe(true);

    // A check that never arrived must not answer "not yours": one dropped
    // packet would otherwise send him off to rename an address he owns. The
    // page tells those apart by the status a refusal carries, so a rejection
    // with none has to come back out of here rather than reading as a no.
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

/**
 * Just enough of a document for the handful of properties these screens touch.
 *
 * The page is lifted rather than rendered, the way its ZIP writer and its claim
 * step are: this file has no DOM, and what is worth asserting about a screen
 * here is which control on it is live — which is the whole of the defect, since
 * a screen with nothing live on it is where the person stops.
 */
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
    /** Renders into the stub box below and answers what it was dressed as. */
    render: (err: unknown) => { className: string; text: string };
  }

  /** The copy table, the lookup over it, and the box it lands in. */
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
    // `POST /api/build`, `GET /api/build/:id`, `POST /api/sites`,
    // `GET /api/names/:name`, `POST /api/sites/:name/releases` and
    // `DELETE /api/sites/:name/hold`, as this page calls them.
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
    // What a dropped tailnet actually rejects with on a phone. It has no code,
    // and its message is the one thing this screen must never read out.
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
    // Every one of these is a reassurance — the address is already yours, what
    // you typed is still here — and they were landing in the red box kept for
    // things going wrong. Told his site is fine in the colour of an alarm, a
    // person learns not to trust the colour.
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
    // A site whose serving page is over the cap is refused 413 before a model
    // is asked anything, so what was too big is the page that is already there
    // — and asking for a smaller change cannot help, because the size is the
    // same whatever he asks for.
    const said = sentence({ code: 'TOO_LARGE', status: 413 }, BEFORE_CHANGING);
    expect(said).not.toMatch(/came back|smaller change/i);
    expect(said).toBeString();
  });
});

/**
 * A span of the page's own script, by the comments that bound it.
 *
 * Lifted rather than rendered, the way the ZIP writer and the claim step are:
 * this file has no DOM, and the claims worth making about a screen are which
 * control on it is live and what it says — which is the whole of the defect,
 * since a screen with nothing live on it is where the person stops. The
 * builder shares the page with the deck now, so every marker here has to be
 * one only the builder has; `nameVerdict` is named as it is for that reason.
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
    // Nobody's: the ordinary road, and the green button is "Put it online".
    expect(propose({ ...frame, available: true, yours: null })).toMatchObject({
      taken: false,
    });
    expect(said.at(-1)).toEqual({ code: null, lead: expect.any(String) });

    // His, with nothing on it — the claim a failed upload stranded. The green
    // button finishes it, and the box says so in the colour for good news.
    expect(
      propose({ ...frame, available: false, yours: 'empty' }),
    ).toMatchObject({ taken: false, yours: 'empty' });
    expect(said.at(-1)?.code).toBe('CLAIMED');

    // His, with a website on it: the one answer that does need another name,
    // and still not "belongs to somebody else".
    expect(
      propose({ ...frame, available: false, yours: 'live' }),
    ).toMatchObject({ taken: true, yours: 'live' });
    expect(said.at(-1)?.code).toBe('YOURS');
    expect(said.at(-1)?.lead).toContain('already your website');

    // Somebody else's, which is the only time the word taken is the truth.
    expect(propose({ ...frame, available: false, yours: null })).toMatchObject({
      taken: true,
    });
    expect(said.at(-1)?.code).toBe('TAKEN');
  });

  test('is on the list, with the one thing left to do with it', async () => {
    // A claim with no release is a name taken for good, a Postgres database
    // and a role. Filtered out of "your websites" it was reachable from no
    // screen on this page, and nothing on the server reclaims it — so a failed
    // upload followed by "Start again" spent one silently and forever.
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

    // And pressing it is the way back: the next page he makes goes on that
    // address rather than on whatever the model proposes for it.
    acts[0]?.onclick?.();
    expect(list.pinnedNow()).toBe('stranded');
  });

  test('the address he picks does not cost him the sentence he typed', async () => {
    // The button sits above the greeting, so the tap that reaches it is most
    // often the one *after* he has typed a paragraph into the box below it.
    // Answering "where does it go" by throwing away "what is it" makes the one
    // recovery on the page a button nobody can afford to press.
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

    // And a box a reload emptied is filled from the backup rather than left
    // blank beside an address that is now waiting for a page.
    ask.value = '';
    lifted.usePinned('stranded');
    expect(ask.value).toBe('a page for my woodworking');
  });

  test('leaves the name screen with something he can press', async () => {
    // The screen has two buttons. Pushed here by a name that is not free it
    // opens holding that name, so the green one starts disabled — and hiding
    // the other left a screen with nothing live on it at all, the page he
    // waited a minute for off it, and a reload the only way out.
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

    // Typing the stranded address back in is the only way back to it once the
    // draft is gone, and it was refused with "somebody already has that one".
    answers.push({ available: false, why: 'TAKEN', yours: 'empty' });
    paintName();
    await Bun.sleep(400);
    expect(page.el('b-usename').disabled).toBe(false);
    expect(verdicts.at(-1)?.kind).toBe('yes');
    expect(verdicts.at(-1)?.say).not.toContain('Somebody');

    // A website of his is not usable here — writing a new page over it is not
    // what this screen does — but the sentence says which it is.
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
  /**
   * The wait screen and the frame reader, lifted together.
   *
   * They are adjacent in the file because they are one mechanism: the screen
   * says what the stream says. The defect they replaced was a screen with
   * nothing to say — held to the model's first content byte the socket was
   * empty for 71-95 s, this counted its own seconds at it, and a browser gave
   * up long before either of them did.
   */
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
        // Recorded one read late on purpose: this is the screen as it stood
        // once the frame before it had been read, which is the only thing
        // somebody holding the phone ever sees.
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
    // A tab throttled in a pocket cannot count, and the thing worth counting
    // is how long the model has been at it rather than how long this screen
    // has been open. `ms` is the server's, so the two cannot drift apart.
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
    // A change of model between two `thinking` frames IS the fallback signal —
    // there is no frame that announces it — and a minute and a half of silence
    // with no reason given is a minute and a half somebody spends wondering
    // whether to press it again.
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
    // Nothing about the upstream is a status any more, so the only place a
    // refusal can arrive is here, in a 200 that has been open and talking
    // since the first millisecond.
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
    // Refused rather than cut: half a document is a broken page that looks
    // published.
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
    // A sentence with nothing nameable in it still has to produce a name.
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
    // The document ceiling is the public one until a deployment raises it, so
    // saying nothing raises nothing.
    expect(read.aiBuildMaxTokens).toBe(read.aiMaxTokens);
  });
});
