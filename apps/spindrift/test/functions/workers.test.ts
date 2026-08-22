/**
 * The Cloudflare Workers function deployer.
 *
 * Every test drives the real class against a fake of the platform's HTTP API
 * (§ Seam 2) and asserts what would have been sent. The claims worth stating:
 *
 * - **A deploy reads the zone, uploads the module, then claims the hostname**,
 *   in that order — the custom domain call cannot be made without the zone id
 *   and must not be made before there is a script to point it at.
 * - **The platform's own words come back**, so an operator reads the refusal
 *   rather than a status code.
 * - **`remove` tolerates absence**, because §6's idempotence applies to a
 *   function that is already gone.
 * - **`tail` deletes its session on abort**, so closing a log view does not
 *   leave a trace session running against the account.
 */
import { describe, expect, test } from 'bun:test';
import { FunctionDeployError } from '../../src/functions/contract.ts';
import { WorkersFunctions } from '../../src/functions/workers.ts';

const ENDPOINT = 'https://edge.example.test/client/v4';

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly request: Request;
}

/** A fake far side: a route table keyed on `METHOD /path`, plus a log of calls. */
function api(routes: Readonly<Record<string, () => Response>> = {}): {
  fetch: (request: Request) => Promise<Response>;
  calls: Seen[];
} {
  const calls: Seen[] = [];
  return {
    calls,
    fetch: async (request) => {
      const url = new URL(request.url);
      const key = `${request.method} ${url.pathname}`;
      calls.push({ method: request.method, path: url.pathname, request });
      const route = routes[key];
      if (route === undefined) {
        return Response.json({ success: true, result: null });
      }
      return route();
    },
  };
}

function ok(result: unknown): Response {
  return Response.json({ success: true, errors: [], result });
}

function deployer(
  fetch: (request: Request) => Promise<Response>,
  overrides: {
    webSocket?: (url: string, protocols: string[]) => WebSocket;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): WorkersFunctions {
  return new WorkersFunctions({
    token: () => 'edge-token',
    accountId: 'account-1',
    zoneNames: ['other.test', 'example.test'],
    endpoint: ENDPOINT,
    fetch,
    ...overrides,
  });
}

describe('WorkersFunctions.deploy', () => {
  test('reads the zone, uploads the module, then claims the hostname', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([{ id: 'zone-1', name: 'example.test' }]),
      'PUT /client/v4/accounts/account-1/workers/scripts/fn-hello': () =>
        ok({ id: 'fn-hello' }),
      'PUT /client/v4/accounts/account-1/workers/domains': () =>
        ok({ id: 'domain-1' }),
    });
    const result = await deployer(far.fetch).deploy(
      'hello',
      'export default { fetch: () => new Response("hi") };',
    );

    expect(result.url).toBe('https://hello.fn.example.test');
    expect(far.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /client/v4/zones',
      'PUT /client/v4/accounts/account-1/workers/scripts/fn-hello',
      'PUT /client/v4/accounts/account-1/workers/domains',
    ]);
    // Scoped to the account, not to a name: the account's own listing is what
    // decides which declared zone is here, and `other.test` is not.
    expect(
      new URL(far.calls[0]!.request.url).searchParams.get('account.id'),
    ).toBe('account-1');
    expect(far.calls[0]!.request.headers.get('Authorization')).toBe(
      'Bearer edge-token',
    );

    // Asserted on the wire rather than through `formData()`: the parser
    // re-infers a part's type from its filename, so a round trip cannot show
    // what was actually sent.
    const wire = await far.calls[1]!.request.clone().text();
    expect(wire).toContain('Content-Type: application/javascript+module');
    const form = await far.calls[1]!.request.formData();
    const metadata = JSON.parse(await (form.get('metadata') as File).text());
    expect(metadata.main_module).toBe('index.mjs');
    expect(metadata.observability).toEqual({
      enabled: true,
      logs: { enabled: true, invocation_logs: true },
    });
    expect(typeof metadata.compatibility_date).toBe('string');
    expect(await (form.get('index.mjs') as File).text()).toContain(
      'export default',
    );

    expect(await far.calls[2]!.request.json()).toEqual({
      hostname: 'hello.fn.example.test',
      service: 'fn-hello',
      zone_id: 'zone-1',
      environment: 'production',
    });
  });

  test('raises the platform’s own sentence', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([{ id: 'zone-1', name: 'example.test' }]),
      'PUT /client/v4/accounts/account-1/workers/scripts/fn-hello': () =>
        Response.json(
          { success: false, errors: [{ code: 10021, message: 'nope' }] },
          { status: 400 },
        ),
    });
    const failure = await deployer(far.fetch)
      .deploy('hello', 'export default {};')
      .catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(FunctionDeployError);
    expect((failure as Error).message).toBe('nope');
  });

  test('says which zone the token cannot see', async () => {
    const far = api({ 'GET /client/v4/zones': () => ok([]) });
    const failure = await deployer(far.fetch)
      .deploy('hello', 'export default {};')
      .catch((cause: unknown) => cause);
    expect((failure as Error).message).toContain('example.test');
  });
});

describe('WorkersFunctions.remove', () => {
  test('takes the domain before the script', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([{ id: 'zone-1', name: 'example.test' }]),
      'GET /client/v4/accounts/account-1/workers/domains': () =>
        ok([{ id: 'domain-1' }]),
    });
    await deployer(far.fetch).remove('hello');
    expect(far.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      // The zone first: the domain is looked up by the hostname it carries,
      // and the hostname is not known until the zone is.
      'GET /client/v4/zones',
      'GET /client/v4/accounts/account-1/workers/domains',
      'DELETE /client/v4/accounts/account-1/workers/domains/domain-1',
      'DELETE /client/v4/accounts/account-1/workers/scripts/fn-hello',
    ]);
    expect(new URL(far.calls[3]!.request.url).searchParams.get('force')).toBe(
      'true',
    );
  });

  test('a function that is already gone is not an error', async () => {
    const far = api({
      'GET /client/v4/zones': () =>
        ok([{ id: 'zone-1', name: 'example.test' }]),
      'GET /client/v4/accounts/account-1/workers/domains': () =>
        Response.json({ success: false, errors: [] }, { status: 404 }),
      'DELETE /client/v4/accounts/account-1/workers/scripts/fn-hello': () =>
        Response.json({ success: false, errors: [] }, { status: 404 }),
    });
    await expect(deployer(far.fetch).remove('hello')).resolves.toBeUndefined();
  });
});

/** A socket a test drives: it delivers frames and reports when it was closed. */
function fakeSocket(): {
  socket: WebSocket;
  deliver(frame: unknown): void;
  closed(): boolean;
} {
  let shut = false;
  const socket = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    onclose: null as (() => void) | null,
    onerror: null as (() => void) | null,
    close() {
      shut = true;
    },
  };
  return {
    socket: socket as unknown as WebSocket,
    deliver: (frame) => {
      socket.onmessage?.({
        data: JSON.stringify(frame),
      } as MessageEvent);
    },
    closed: () => shut,
  };
}

describe('WorkersFunctions.tail', () => {
  test('maps a frame to lines and deletes the session on abort', async () => {
    const far = api({
      'POST /client/v4/accounts/account-1/workers/scripts/fn-hello/tails': () =>
        ok({ id: 'tail-1', url: 'wss://trace.example.test/tail-1' }),
    });
    const fake = fakeSocket();
    let openedWith: readonly string[] = [];
    const abort = new AbortController();
    const stream = deployer(far.fetch, {
      webSocket: (_url, protocols) => {
        openedWith = protocols;
        return fake.socket;
      },
    }).tail('hello', abort.signal);

    const first = stream.next();
    await Bun.sleep(1);
    fake.deliver({
      eventTimestamp: 1_700_000_000_000,
      outcome: 'ok',
      event: { request: { method: 'POST', url: 'https://x.test/orders?a=1' } },
      logs: [
        {
          message: ['hi', { n: 1 }],
          level: 'log',
          timestamp: 1_700_000_000_001,
        },
        { message: ['careful'], level: 'warn' },
      ],
      exceptions: [{ name: 'TypeError', message: 'boom' }],
    });

    const lines = [(await first).value];
    for (let index = 0; index < 3; index += 1) {
      lines.push((await stream.next()).value);
    }
    expect(lines.map((entry) => entry?.line)).toEqual([
      'hi {"n":1}',
      'careful',
      'TypeError: boom',
      'POST /orders → ok',
    ]);
    expect(lines.map((entry) => entry?.level)).toEqual([
      'log',
      'warn',
      'error',
      'info',
    ]);
    expect(lines[0]?.at).toBe(new Date(1_700_000_000_001).toISOString());
    expect(openedWith).toEqual(['trace-v1']);

    abort.abort();
    await stream.next();
    expect(fake.closed()).toBe(true);
    expect(far.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /client/v4/accounts/account-1/workers/scripts/fn-hello/tails',
      'DELETE /client/v4/accounts/account-1/workers/scripts/fn-hello/tails/tail-1',
    ]);
  });

  test('reopens a session the far side closed, after a pause', async () => {
    const far = api({
      'POST /client/v4/accounts/account-1/workers/scripts/fn-hello/tails': () =>
        ok({ id: 'tail-1', url: 'wss://trace.example.test/tail-1' }),
    });
    const sockets = [fakeSocket(), fakeSocket()];
    let opened = 0;
    const slept: number[] = [];
    const abort = new AbortController();
    const stream = deployer(far.fetch, {
      webSocket: () => sockets[opened++]!.socket,
      sleep: async (ms) => {
        slept.push(ms);
      },
    }).tail('hello', abort.signal);

    const first = stream.next();
    await Bun.sleep(1);
    sockets[0]!.deliver({ logs: [{ message: ['one'], level: 'log' }] });
    expect((await first).value?.line).toBe('one');

    const second = stream.next();
    await Bun.sleep(1);
    (
      sockets[0]!.socket as unknown as { onclose: (() => void) | null }
    ).onclose?.();
    await Bun.sleep(5);
    sockets[1]!.deliver({ logs: [{ message: ['two'], level: 'log' }] });
    expect((await second).value?.line).toBe('two');

    expect(slept).toEqual([1_000]);
    expect(opened).toBe(2);
    expect(far.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /client/v4/accounts/account-1/workers/scripts/fn-hello/tails',
      'DELETE /client/v4/accounts/account-1/workers/scripts/fn-hello/tails/tail-1',
      'POST /client/v4/accounts/account-1/workers/scripts/fn-hello/tails',
    ]);

    abort.abort();
    await stream.next();
  });
});
