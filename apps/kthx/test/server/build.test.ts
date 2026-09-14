/**
 * `POST /api/build`: which door has it, what is not trusted about an answer,
 * and what it costs.
 *
 * A real stub upstream that really streams, because every interesting claim
 * here is about time and framing rather than about a return value: the response
 * is held until the model's first content byte, the page is fed progress after
 * it, and a model that thinks for forty seconds must not be cut off by a
 * connection timeout nobody sees fire.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { BUILD_PATH } from '@repo/kthx/assets';
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
 * Both halves of a real generation, because the socket is idle in two different
 * ways: before the first content byte this server is holding the response, and
 * after it this server is a slow response body. Bun's idle timer treats those
 * differently, and the route has to survive both.
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

    expect(all[0]).toEqual({ t: 'start', model: 'writer' });
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
    expect(last).toMatchObject({ name, available: false });
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

    expect(all[0]).toEqual({ t: 'start', model: 'second-writer' });
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
    const refused = await post({ ask: 'a page' });
    expect(refused.status).toBe(502);
    expect((await refused.json()).code).toBe('AI_UPSTREAM');
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
    const refused = await post({ ask: 'a page for my woodworking' });
    expect(refused.status).toBe(502);
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
    const refused = await post({ ask: 'a page' });
    expect(refused.status).toBe(502);
    expect(await spent()).toEqual({ requests: 2, tokens: 0 });
  });

  test('gives the slot back when the control database does not answer', async () => {
    // The attempt is counted against the day before the upstream is dialled,
    // and an ordinary CNPG blip rejects that await. The in-flight slot is taken
    // before it: released on the paths that return and not on the one that
    // throws, a single Postgres error left this login reading "one at a time"
    // for the life of the pod, and four of them closed the builder for
    // everybody on the tailnet.
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
    // 30-150 s a measured generation takes — and this route sends nothing
    // until the model writes its first word. Without the per-request
    // `server.timeout` the socket closes with no status, no body and no log
    // line, on the least technical caller this server has. Timed rather than
    // mocked: `server.timeout` is a fact about a socket, and a fake that
    // records the call would pass with the argument in seconds or in
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

describe('the page the identity host serves', () => {
  test('is the builder, told who is reading it', async () => {
    const served = await ontailnet('/', DAD);
    expect(served.status).toBe(200);
    const html = await served.text();
    expect(html).toContain(`data-login="${DAD}"`);
    expect(html).toContain(`data-zone="${ZONE}"`);
    expect(html).toContain('What would you like a website for?');
  });

  test('says one sentence to a caller the tailnet did not name', async () => {
    const html = await (await ontailnet('/', null)).text();
    expect(html).not.toContain('data-login');
    expect(html).toContain('needs your Tailscale login');
  });

  test('is not the landing page, which still answers everywhere else', async () => {
    // The landing page's breakage is what reverted a ticket once. It has no
    // seventh section, and it did not move.
    for (const host of [ZONE, CONTROL]) {
      const html = await (
        await kthx().fetch(ask('/', { host }), peer(PROXY))
      ).text();
      expect(html).toContain('kthx.dev</title>');
      expect(html).not.toContain('What would you like a website for?');
    }
  });
});

describe('the whole road, as the page walks it', () => {
  /**
   * The page's own ZIP writer, lifted out of the file it lives in.
   *
   * It is twenty lines of hand-written ZIP that nothing else in this repo
   * parses until an upload arrives, so the assertion worth having is that the
   * release route reads what that page writes.
   */
  async function pageZip(): Promise<(name: string, bytes: Uint8Array) => Blob> {
    const html = await Bun.file(BUILD_PATH).text();
    const from = html.indexOf('let crcTable;');
    const to = html.indexOf('async function put(');
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
