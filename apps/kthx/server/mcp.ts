/**
 * `/api/mcp`: the site's own API, as tools.
 *
 * Stateless Streamable HTTP, protocol revision 2025-06-18: one JSON-RPC 2.0
 * message in, one JSON response out. No session id, no SSE, no server-initiated
 * stream — the same shape `apps/spindrift/src/web/mcp-route.ts` serves, which is
 * the least protocol that works and needs no client library on either side.
 *
 * **No tool reaches a database.** Each one names a call on this server's own
 * `/api` and is answered by the handler that route already has, so the quotas,
 * the etag rules, the 507 at 256 MiB and the frame published to `/api/ws` are
 * exactly the ones a browser gets. A second implementation of the collections
 * grammar is the thing this file exists to not be.
 *
 * Owner-only, unlike every other backend: every tool here is the owner's, an
 * agent holding the bearer is the owner by definition, and there is no visitor
 * to mint a cookie for.
 */
import { bodyOf, dbApi } from './documents.ts';
import { type Code, isJson, ok, refuse } from './http.ts';
import { type Ctx, sitesApi } from './sites.ts';

/** The revision this endpoint speaks. */
const PROTOCOL_VERSION = '2025-06-18';

/** The `/api` call a tool is, once its arguments are read. */
interface Call {
  readonly method: string;
  /** Percent-encoded, because the handlers decode their own segments. */
  readonly path: string;
  /**
   * Sent as JSON on `POST`/`PATCH`/`PUT`. An absent body becomes `null`, which
   * the document handlers refuse for themselves.
   */
  readonly body?: unknown;
  readonly ifMatch?: string;
  /** `site_info` is the apex control API; every other tool is the site's own. */
  readonly apex?: boolean;
}

type Args = Record<string, unknown>;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  /** The call to make, or the code that refuses these arguments outright. */
  readonly plan: (args: Args, site: string) => Call | Code;
}

const NO_ARGS = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

const COLLECTION = {
  type: 'string',
  description: 'the collection: 1 to 64 of a-z, 0-9, - and _',
};
const ID = { type: 'string', description: 'the document id' };

function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const string = (value: unknown): string | null =>
  typeof value === 'string' ? value : null;

/** `/api/db/<collection>[/<id>]`, with both parts encoded for the router. */
function dbPath(collection: string, id?: string): string {
  const tail = id === undefined ? '' : `/${encodeURIComponent(id)}`;
  return `/api/db/${encodeURIComponent(collection)}${tail}`;
}

/**
 * The tools, in the order a model should meet them.
 *
 * `files_list` is in the contract and lands with `/api/files`: a tool whose
 * route this server does not have yet would be a promise, not a capability.
 */
const TOOLS: readonly Tool[] = [
  {
    name: 'site_info',
    description:
      'This site: its url, which release serves, every release, usage and quotas.',
    inputSchema: NO_ARGS,
    plan: (_args, site) => ({
      method: 'GET',
      path: `/api/sites/${encodeURIComponent(site)}`,
      apex: true,
    }),
  },
  {
    name: 'db_collections',
    description: 'Every collection holding a document, with its row count.',
    inputSchema: NO_ARGS,
    plan: () => ({ method: 'GET', path: '/api/db' }),
  },
  {
    name: 'db_query',
    description:
      'Documents matching a where object. Keys are field paths — id, created_at, updated_at, or a dotted path into the document — and values are either a JSON value for equality or one operator object: $gt $gte $lt $lte $ne $in $nin $like $ilike $exists.',
    inputSchema: schema(
      {
        collection: COLLECTION,
        where: { type: 'object', description: 'at most 16 keys, ANDed' },
        orderBy: {
          type: 'string',
          description: '"<path>" or "<path> desc"; default "created_at desc"',
        },
        limit: { type: 'integer', description: 'default 100, at most 500' },
        offset: { type: 'integer' },
        count: {
          type: 'boolean',
          description: 'also return the total matching where, ignoring limit',
        },
      },
      ['collection'],
    ),
    plan: (args) => {
      const collection = string(args.collection);
      if (collection === null) return 'INVALID_COLLECTION';
      const { collection: _named, ...query } = args;
      return {
        method: 'POST',
        path: `${dbPath(collection)}/query`,
        body: query,
      };
    },
  },
  {
    name: 'db_get',
    description: 'One document by id.',
    inputSchema: schema({ collection: COLLECTION, id: ID }, [
      'collection',
      'id',
    ]),
    plan: (args) => {
      const collection = string(args.collection);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = string(args.id);
      if (id === null) return 'INVALID_ID';
      return { method: 'GET', path: dbPath(collection, id) };
    },
  },
  {
    name: 'db_create',
    description:
      'Store a document. An id in the document is used as the key; without one the server mints a uuid.',
    inputSchema: schema({ collection: COLLECTION, doc: { type: 'object' } }, [
      'collection',
      'doc',
    ]),
    plan: (args) => {
      const collection = string(args.collection);
      if (collection === null) return 'INVALID_COLLECTION';
      return { method: 'POST', path: dbPath(collection), body: args.doc };
    },
  },
  {
    name: 'db_update',
    description:
      'Shallow-merge the patch into a document: a nested object or array replaces the stored one whole, and null stores null. overwrite replaces the document, which is the only way to drop a key. Pass the document etag as ifMatch to fail on a concurrent write.',
    inputSchema: schema(
      {
        collection: COLLECTION,
        id: ID,
        patch: { type: 'object' },
        overwrite: { type: 'boolean' },
        ifMatch: { type: 'string', description: "the document's etag" },
      },
      ['collection', 'id', 'patch'],
    ),
    plan: (args) => {
      const collection = string(args.collection);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = string(args.id);
      if (id === null) return 'INVALID_ID';
      const overwrite = args.overwrite === true ? '?overwrite=1' : '';
      const ifMatch = string(args.ifMatch);
      return {
        method: 'PATCH',
        path: `${dbPath(collection, id)}${overwrite}`,
        body: args.patch,
        ...(ifMatch === null ? {} : { ifMatch }),
      };
    },
  },
  {
    name: 'db_delete',
    description: 'Delete one document. Deleting what is not there succeeds.',
    inputSchema: schema({ collection: COLLECTION, id: ID }, [
      'collection',
      'id',
    ]),
    plan: (args) => {
      const collection = string(args.collection);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = string(args.id);
      if (id === null) return 'INVALID_ID';
      return { method: 'DELETE', path: dbPath(collection, id) };
    },
  },
];

const LISTED = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

/** Exported for the test that keeps this list and the contract in step. */
export const mcpToolNames: readonly string[] = TOOLS.map((tool) => tool.name);

// --- tool calls -------------------------------------------------------------

function isObject(value: unknown): value is Args {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The one shape a tool answers with. */
function content(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * The `/api` response, as a tool result.
 *
 * A refusal keeps its code: `<CODE>: <message>` is the sentence the HTTP caller
 * reads, and the code is the part a model can act on — `PRECONDITION_FAILED`
 * means read it again and retry, `SITE_FULL` means delete something first. It
 * is a result and not a JSON-RPC error because the model is meant to read it
 * and act, which a transport fault gives it no way to do.
 */
async function resultOf(response: Response) {
  if (response.status === 204) {
    return content(JSON.stringify({ deleted: true }));
  }
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    return content(`${String(body.code)}: ${String(body.message)}`, true);
  }
  return content(JSON.stringify(body, null, 2));
}

/**
 * The call, made against this server's own handlers.
 *
 * The bearer travels with it because those handlers check ownership themselves:
 * `site_info` reads the site row through the apex's own check rather than being
 * handed a row this file decided it could see.
 */
async function forward(
  request: Request,
  ctx: Ctx,
  site: string,
  call: Call,
): Promise<Response> {
  const headers = new Headers();
  const bearer = request.headers.get('authorization');
  if (bearer !== null) headers.set('authorization', bearer);
  if (call.ifMatch !== undefined) headers.set('if-match', call.ifMatch);
  const writes =
    call.method === 'POST' || call.method === 'PATCH' || call.method === 'PUT';
  if (writes) headers.set('content-type', 'application/json');

  const url = new URL(call.path, request.url);
  const inner = new Request(url, {
    method: call.method,
    headers,
    body: writes ? JSON.stringify(call.body ?? null) : undefined,
  });
  // The encoded path, split the way the routers take it.
  const segments = url.pathname.split('/');
  return call.apex === true
    ? ((await sitesApi(inner, ctx, segments)) ?? refuse('NOT_FOUND', ctx.id))
    : dbApi(inner, ctx, site, segments, true);
}

// --- the endpoint -----------------------------------------------------------

interface Rpc {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { name?: unknown; arguments?: unknown };
}

/**
 * `POST /api/mcp`, already known to carry this site's bearer.
 *
 * The caller checks the method, the bearer and the write bucket; what is left
 * here is the framing.
 */
export async function mcpApi(
  request: Request,
  ctx: Ctx,
  site: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  // One message per request: a batch is a second framing to hold, and this
  // revision does not require one.
  if (!isObject(body.json)) return refuse('MALFORMED_REQUEST', ctx.id);
  const rpc = body.json as Rpc;

  // A notification carries no id and is owed no response — `initialized` is the
  // one every client sends.
  if (rpc.id === undefined) {
    return new Response(null, {
      status: 202,
      headers: {
        'x-content-type-options': 'nosniff',
        'x-request-id': ctx.id,
        'cache-control': 'no-store',
      },
    });
  }

  const reply = (result: unknown) =>
    ok({ jsonrpc: '2.0', id: rpc.id, result }, ctx.id);

  switch (rpc.method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'kthx', version: '2' },
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: LISTED });
    case 'tools/call': {
      const name = rpc.params?.name;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) {
        return reply(
          content(`NOT_FOUND: there is no tool called ${String(name)}`, true),
        );
      }
      const args = isObject(rpc.params?.arguments) ? rpc.params.arguments : {};
      const call = tool.plan(args, site);
      // A refusal this file decided is still built by `refuse`, so its sentence
      // comes from the one error table.
      const answer =
        typeof call === 'string'
          ? refuse(call, ctx.id)
          : await forward(request, ctx, site, call);
      return reply(await resultOf(answer));
    }
    default:
      return ok(
        {
          jsonrpc: '2.0',
          id: rpc.id,
          error: {
            code: -32601,
            message: `unknown method ${String(rpc.method)}`,
          },
        },
        ctx.id,
      );
  }
}
