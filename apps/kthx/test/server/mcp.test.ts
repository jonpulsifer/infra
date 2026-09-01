/**
 * `/api/mcp`: the framing, and that every tool is the `/api` handler behind it.
 *
 * The round trip is the whole client this transport needs — one JSON-RPC
 * message per POST, no session, no stream — so the test is the same fetch an
 * editor makes. What it is really asserting is that no tool has its own
 * implementation: a document created through `db_create` carries the server's
 * etag and timestamps, and `db_update` with a stale etag is refused, which only
 * the real `/api/db` statement does.
 */
import { describe, expect, test } from 'bun:test';
import { writes } from '../../server/limits.ts';
import { ask, withServer, ZONE } from '../harness/server.ts';

/** The contract's tool table, written out so the server cannot define it. */
const TOOLS = [
  'site_info',
  'db_collections',
  'db_query',
  'db_get',
  'db_create',
  'db_update',
  'db_delete',
];

const kthx = withServer();

let nextAddress = 0;
function address(): string {
  nextAddress += 1;
  return `198.18.1.${nextAddress % 250}`;
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

/** One JSON-RPC message, as a client sends it. */
function post(
  site: Site,
  message: Record<string, unknown>,
  token: string | undefined = site.token,
): Promise<Response> {
  return kthx().fetch(
    ask('/api/mcp', {
      host: site.host,
      method: 'POST',
      token,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', ...message }),
    }),
  );
}

interface Rpc {
  readonly id?: unknown;
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

async function send(
  site: Site,
  message: Record<string, unknown>,
): Promise<Rpc> {
  const response = await post(site, { id: 1, ...message });
  expect(response.status).toBe(200);
  return (await response.json()) as Rpc;
}

interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

async function call(
  site: Site,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const answer = await send(site, {
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const result = answer.result as {
    content: { type: string; text: string }[];
    isError: boolean;
  };
  expect(result.content[0]?.type).toBe('text');
  return { text: result.content[0]?.text ?? '', isError: result.isError };
}

/** A tool that succeeded, as the JSON it answered with. */
async function json(
  site: Site,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const result = await call(site, name, args);
  expect(result.isError).toBe(false);
  return JSON.parse(result.text) as Record<string, unknown>;
}

describe('the protocol', () => {
  test('initialize names the server and its tools capability', async () => {
    const site = await claimed('mcp-init');
    const answer = await send(site, {
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    expect(answer.result).toEqual({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'kthx', version: '2' },
    });
  });

  test('a notification is answered 202 with no body', async () => {
    const site = await claimed('mcp-note');
    const response = await post(site, { method: 'notifications/initialized' });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('');
  });

  test('tools/list is the contract list', async () => {
    const site = await claimed('mcp-list');
    const answer = await send(site, { method: 'tools/list' });
    const tools = (answer.result as { tools: { name: string }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(TOOLS);
    for (const tool of tools) {
      expect(tool).toMatchObject({
        description: expect.any(String),
        inputSchema: { type: 'object' },
      });
    }
  });

  test('ping answers, an unknown method does not', async () => {
    const site = await claimed('mcp-ping');
    expect((await send(site, { method: 'ping' })).result).toEqual({});
    const answer = await send(site, { method: 'resources/list' });
    expect(answer.error?.code).toBe(-32601);
  });

  test('an unknown tool is an error result, not a transport fault', async () => {
    const site = await claimed('mcp-tool');
    const result = await call(site, 'db_drop_everything');
    expect(result.isError).toBe(true);
    expect(result.text).toStartWith('NOT_FOUND:');
  });

  test('a body that is not one JSON-RPC object is refused', async () => {
    const site = await claimed('mcp-body');
    for (const body of ['[]', 'null', 'not json']) {
      const response = await kthx().fetch(
        ask('/api/mcp', {
          host: site.host,
          method: 'POST',
          token: site.token,
          headers: { 'content-type': 'application/json' },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code: string }).code).toBe(
        'MALFORMED_REQUEST',
      );
    }
  });

  test('GET has no stream to open', async () => {
    const site = await claimed('mcp-get');
    const response = await kthx().fetch(
      ask('/api/mcp', { host: site.host, token: site.token }),
    );
    expect(response.status).toBe(405);
  });
});

describe('the bearer', () => {
  test('is required, and must be the one that opens this site', async () => {
    const site = await claimed('mcp-auth');
    const other = await claimed('mcp-other');

    const anonymous = await kthx().fetch(
      ask('/api/mcp', {
        host: site.host,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
    );
    expect(anonymous.status).toBe(401);

    const wrong = await post(
      site,
      { id: 1, method: 'tools/list' },
      other.token,
    );
    expect(wrong.status).toBe(403);
  });
});

describe('the tools', () => {
  test('site_info is the control API answer', async () => {
    const site = await claimed('mcp-info');
    const info = await json(site, 'site_info');
    expect(info).toMatchObject({
      name: site.name,
      serving: null,
      releases: [],
    });
    expect((info.usage as { db_bytes: number }).db_bytes).toBeGreaterThan(0);
  });

  test('a document through the tools is a document through /api/db', async () => {
    const site = await claimed('mcp-docs');

    const created = await json(site, 'db_create', {
      collection: 'notes',
      doc: { title: 'first', done: false },
    });
    expect(created).toMatchObject({ title: 'first', done: false });
    const id = created.id as string;
    expect(typeof created.etag).toBe('string');

    expect(await json(site, 'db_get', { collection: 'notes', id })).toEqual(
      created,
    );

    expect(await json(site, 'db_collections')).toEqual({
      collections: [{ name: 'notes', count: 1 }],
    });

    const found = await json(site, 'db_query', {
      collection: 'notes',
      where: { done: false },
      count: true,
    });
    expect(found.count).toBe(1);
    expect((found.items as unknown[]).length).toBe(1);

    const updated = await json(site, 'db_update', {
      collection: 'notes',
      id,
      patch: { done: true },
      ifMatch: created.etag,
    });
    expect(updated).toMatchObject({ title: 'first', done: true });
    expect(updated.etag).not.toBe(created.etag);

    // The etag the write moved past: the shared statement is what refuses this,
    // and a tool with its own SQL would not.
    const stale = await call(site, 'db_update', {
      collection: 'notes',
      id,
      patch: { done: false },
      ifMatch: created.etag,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toStartWith('PRECONDITION_FAILED:');

    // `overwrite` drops the keys the patch does not carry.
    const replaced = await json(site, 'db_update', {
      collection: 'notes',
      id,
      patch: { title: 'only' },
      overwrite: true,
    });
    expect(replaced.done).toBeUndefined();

    expect(await json(site, 'db_delete', { collection: 'notes', id })).toEqual({
      deleted: true,
    });
    const gone = await call(site, 'db_get', { collection: 'notes', id });
    expect(gone.isError).toBe(true);
    expect(gone.text).toStartWith('NOT_FOUND:');
  });

  test('the handlers validate what the tools pass through', async () => {
    const site = await claimed('mcp-invalid');
    expect(
      (await call(site, 'db_get', { collection: 7, id: 'a' })).text,
    ).toStartWith('INVALID_COLLECTION:');
    expect(
      (await call(site, 'db_get', { collection: 'notes', id: 7 })).text,
    ).toStartWith('INVALID_ID:');
    expect(
      (await call(site, 'db_create', { collection: 'notes', doc: 'nope' }))
        .text,
    ).toStartWith('INVALID_DOCUMENT:');
    expect(
      (
        await call(site, 'db_query', {
          collection: 'notes',
          where: { a: { $nope: 1 } },
        })
      ).text,
    ).toStartWith('INVALID_QUERY:');
  });

  test('an argument never becomes path text', async () => {
    const site = await claimed('mcp-path');
    // `new URL` collapses these before the router splits the path: `..` used to
    // answer a db_get with the collection list, `.` with an empty query.
    for (const collection of ['..', '.', 'a/b', 'Notes']) {
      const answer = await call(site, 'db_get', { collection, id: 'zzz' });
      expect(answer.isError).toBe(true);
      expect(answer.text).toStartWith('INVALID_COLLECTION:');
    }
    const dotted = await call(site, 'db_get', {
      collection: 'notes',
      id: '../..',
    });
    expect(dotted.text).toStartWith('INVALID_ID:');
  });

  test('a malformed ifMatch is refused, not dropped', async () => {
    const site = await claimed('mcp-etag');
    const doc = await json(site, 'db_create', {
      collection: 'notes',
      doc: { title: 'one' },
    });
    // A control character used to throw out of `Headers` and land as a 500.
    for (const ifMatch of ['x\r\nX-Evil: 1', 'not-an-etag', 7]) {
      const answer = await call(site, 'db_update', {
        collection: 'notes',
        id: doc.id,
        patch: { title: 'two' },
        ifMatch,
      });
      expect(answer.isError).toBe(true);
      expect(answer.text).toStartWith('PRECONDITION_FAILED:');
    }
    // And the write it guarded did not happen.
    expect(
      (await json(site, 'db_get', { collection: 'notes', id: doc.id })).title,
    ).toBe('one');
    // A real etag still holds.
    expect(
      (
        await json(site, 'db_update', {
          collection: 'notes',
          id: doc.id,
          patch: { title: 'two' },
          ifMatch: String(doc.etag),
        })
      ).title,
    ).toBe('two');
  });

  test('reads are unmetered, writes spend the site bucket', async () => {
    const site = await claimed('mcp-meter');
    await json(site, 'db_create', { collection: 'notes', doc: { a: 1 } });
    while (!writes.site.spend(site.name)) {
      // drain this site's bucket
    }
    expect((await send(site, { method: 'ping' })).result).toEqual({});
    expect(
      (await call(site, 'db_query', { collection: 'notes' })).isError,
    ).toBe(false);
    const refused = await call(site, 'db_create', {
      collection: 'notes',
      doc: { a: 2 },
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toStartWith('RATE_LIMITED:');
  });
});
