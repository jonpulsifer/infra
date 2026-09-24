/**
 * `/api/mcp`: the site's own API as tools, over stateless Streamable HTTP. Each
 * tool is answered by an existing `/api` handler, so quotas, etags and realtime
 * frames match what a browser gets.
 */
import { bodyOf, dbApi, isPlainObject } from './documents.ts';
import { type Code, isJson, ok, refuse } from './http.ts';
import { spendAll, writes } from './limits.ts';
import { type Ctx, sitesApi } from './sites.ts';

const PROTOCOL_VERSION = '2025-06-18';

/** The `/api` call a tool is, once its arguments are read. */
interface Call {
  readonly method: string;
  /** Percent-encoded, because the handlers decode their own segments. */
  readonly path: string;
  /** An absent body is sent as `null`, which the document handlers refuse. */
  readonly body?: unknown;
  readonly ifMatch?: string;
  /** The apex control API, for `site_info`; other tools call the site's own. */
  readonly apex?: boolean;
}

type Args = Record<string, unknown>;

interface Tool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
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

/**
 * Checked before an argument becomes path text or a header: `new URL` collapses
 * a `..` that `encodeURIComponent` leaves, so `{collection:".."}` would list
 * collections, and `Headers` throws on a control character in `ifMatch`.
 */
const COLLECTION_RE = /^[a-z0-9_-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** `*` means the document exists. */
const ETAG_RE = /^(\*|[0-9a-f]{64}|"[0-9a-f]{64}")$/;

const matching = (value: unknown, pattern: RegExp): string | null =>
  typeof value === 'string' && pattern.test(value) ? value : null;

function dbPath(collection: string, id?: string): string {
  const tail = id === undefined ? '' : `/${encodeURIComponent(id)}`;
  return `/api/db/${encodeURIComponent(collection)}${tail}`;
}

/** In the order a model should meet them. */
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
      const collection = matching(args.collection, COLLECTION_RE);
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
      const collection = matching(args.collection, COLLECTION_RE);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = matching(args.id, ID_RE);
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
      const collection = matching(args.collection, COLLECTION_RE);
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
      const collection = matching(args.collection, COLLECTION_RE);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = matching(args.id, ID_RE);
      if (id === null) return 'INVALID_ID';
      const overwrite = args.overwrite === true ? '?overwrite=1' : '';
      // A dropped `If-Match` would turn compare-and-set into a blind write.
      const ifMatch = matching(args.ifMatch, ETAG_RE);
      if (args.ifMatch !== undefined && ifMatch === null) {
        return 'PRECONDITION_FAILED';
      }
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
      const collection = matching(args.collection, COLLECTION_RE);
      if (collection === null) return 'INVALID_COLLECTION';
      const id = matching(args.id, ID_RE);
      if (id === null) return 'INVALID_ID';
      return { method: 'DELETE', path: dbPath(collection, id) };
    },
  },
];

/** These spend the site write bucket; the rest are reads. */
const WRITING = new Set(['db_create', 'db_update', 'db_delete']);

const LISTED = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

function content(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * A refusal becomes an error result that keeps its code, not a JSON-RPC error,
 * so a model can act on it.
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

/** Forwards the bearer: the apex handler checks ownership itself. */
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
  const segments = url.pathname.split('/');
  return call.apex === true
    ? ((await sitesApi(inner, ctx, segments)) ?? refuse('NOT_FOUND', ctx.id))
    : dbApi(inner, ctx, site, segments, true);
}

interface Rpc {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: { name?: unknown; arguments?: unknown };
}

/** The caller has already checked the method and the owner's bearer. */
export async function mcpApi(
  request: Request,
  ctx: Ctx,
  site: string,
): Promise<Response> {
  if (!isJson(request)) return refuse('MALFORMED_REQUEST', ctx.id);
  const body = await bodyOf(request);
  if ('code' in body) return refuse(body.code, ctx.id);
  // One message per request: this protocol revision has no batches.
  if (!isPlainObject(body.json)) return refuse('MALFORMED_REQUEST', ctx.id);
  const rpc = body.json as Rpc;

  // A notification, such as `initialized`, has no id and gets no response.
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
      const args = isPlainObject(rpc.params?.arguments)
        ? rpc.params.arguments
        : {};
      const call = tool.plan(args, site);
      if (typeof call === 'string') {
        return reply(await resultOf(refuse(call, ctx.id)));
      }
      // After the argument checks, so a refused call costs nothing.
      if (WRITING.has(tool.name) && spendAll([[writes.site, site]])) {
        return reply(
          await resultOf(
            refuse('RATE_LIMITED', ctx.id, { 'retry-after': '60' }),
          ),
        );
      }
      return reply(await resultOf(await forward(request, ctx, site, call)));
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
