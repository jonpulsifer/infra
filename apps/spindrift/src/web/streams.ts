/**
 * The authenticated browser streams (§17): terminating attempt events,
 * non-terminating runtime output, and a Function's non-terminating log tail.
 * Their routes, cursors, and payloads remain distinct so build output can
 * never be presented as application stdout.
 *
 * The Function stream is the odd one out: `deployer.tail` is already an
 * async generator with its own cadence, so its socket runs that generator
 * directly from `open` rather than joining the shared 750ms `pump` the other
 * two kinds share — there is no page to poll for.
 *
 * `ATTEMPT_STREAM_PATH`, `RUNTIME_STREAM_PATH`, `STREAM_PATHS`, and the
 * message types live in `./stream-path.ts` and are re-exported below rather
 * than defined here, because those are the only edge `stream-client.ts`
 * needs into this file — everything else here pulls in `db/schema.ts`,
 * `db/notify.ts`, and `drizzle-orm` as values, which drags the whole
 * database layer into the browser bundle. `test/web/client-bundle.test.ts`
 * guards against that edge coming back.
 */
import { and, eq } from 'drizzle-orm';
import type {
  DeployAdapter,
  DeployTarget,
  RuntimeLogSubject,
} from '../adapters/deploy/contract.ts';
import type { RequestAuthentication } from '../auth/types.ts';
import type { CommandContext, Principal } from '../commands/types.ts';
import { onAttemptEvent } from '../db/notify.ts';
import { components, deploys, targets, vessels } from '../db/schema.ts';
import {
  type AttemptLogCursor,
  readAttemptStream,
} from '../domain/attempt-log.ts';
import { isLabel } from '../domain/naming.ts';
import {
  deployTargetOf,
  hasTargetConnection,
  hasVesselLocation,
} from '../domain/target.ts';
import {
  FUNCTION_NAME_PATTERN,
  type FunctionDeployer,
  type FunctionTarget,
} from '../functions/contract.ts';
import { type KthxSocketData, kthxSocket } from '../kthx/data.ts';
import {
  ATTEMPT_LOG_TEXT_PATH,
  ATTEMPT_STREAM_PATH,
  type AttemptStreamMessage,
  FUNCTION_LOG_STREAM_PATH,
  type FunctionLogPage,
  type FunctionLogStreamMessage,
  RUNTIME_STREAM_PATH,
  type RuntimeStreamMessage,
  STREAM_PATHS,
  type StreamErrorMessage,
  type StreamMessage,
} from './stream-path.ts';

export {
  ATTEMPT_LOG_TEXT_PATH,
  ATTEMPT_STREAM_PATH,
  type AttemptStreamMessage,
  FUNCTION_LOG_STREAM_PATH,
  type FunctionLogPage,
  type FunctionLogStreamMessage,
  RUNTIME_STREAM_PATH,
  type RuntimeStreamMessage,
  STREAM_PATHS,
  type StreamErrorMessage,
  type StreamMessage,
};

export interface StreamDeps {
  authenticate(request: Request): Promise<RequestAuthentication>;
  /**
   * Assembled per connection, and current as of it — the same reason the
   * command boundary's is asynchronous: configuration is the UI's to drive.
   */
  context(principal: Principal): CommandContext | Promise<CommandContext>;
}

interface AttemptSocketData {
  readonly kind: 'attempt';
  readonly context: CommandContext;
  readonly componentId: string;
  readonly buildId: number;
  readonly deployId?: number;
  cursor: AttemptLogCursor | null;
  closed: boolean;
  /** Tear down the in-process event subscription (Transport shape). */
  unsubscribe: (() => void) | null;
}

interface RuntimeSocketData {
  readonly kind: 'runtime';
  readonly adapter: DeployAdapter;
  readonly target: DeployTarget;
  readonly subject: RuntimeLogSubject;
  cursor: string | null;
  closed: boolean;
}

interface FunctionSocketData {
  readonly kind: 'function';
  readonly name: string;
  readonly deployer: FunctionDeployer;
  readonly abort: AbortController;
  closed: boolean;
}

/**
 * A kthx site's socket (`src/kthx/data.ts`) — the one kind here that is
 * client-driven and unauthenticated, reached on a site host rather than
 * under `/internal/streams/`. It shares this union only because `Bun.serve`
 * takes one `websocket` handler per server.
 */
export type StreamSocketData =
  | AttemptSocketData
  | RuntimeSocketData
  | FunctionSocketData
  | KthxSocketData;

type StreamHandler = (
  request: Request,
  server: Bun.Server<StreamSocketData>,
) => Promise<Response | undefined>;

export function streamRoutes(deps: StreamDeps): Record<string, StreamHandler> {
  return {
    [ATTEMPT_STREAM_PATH]: (request, server) =>
      upgradeAttempt(request, server, deps),
    [RUNTIME_STREAM_PATH]: (request, server) =>
      upgradeRuntime(request, server, deps),
    [FUNCTION_LOG_STREAM_PATH]: (request, server) =>
      upgradeFunctionLog(request, server, deps),
  };
}

async function authenticate(
  request: Request,
  deps: StreamDeps,
): Promise<
  { readonly principal: Principal; readonly context: CommandContext } | Response
> {
  const authentication = await deps.authenticate(request);
  if (authentication.kind === 'anonymous') {
    return refusal(401, 'UNAUTHENTICATED', 'a stream requires a session');
  }
  if (authentication.kind === 'forbidden') {
    return refusal(403, 'FORBIDDEN', authentication.message);
  }
  return {
    principal: authentication.principal,
    context: await deps.context(authentication.principal),
  };
}

/**
 * The attempt a request names, checked the way every read of it is checked:
 * the session first, then that the Build exists and the Deploy, if named, is
 * one of its. Shared by the upgrade and the plain-text document so the two
 * cannot disagree about what a session may read.
 */
async function resolveAttempt(
  request: Request,
  deps: StreamDeps,
): Promise<
  | {
      readonly context: CommandContext;
      readonly component: string;
      readonly componentId: string;
      readonly buildId: number;
      readonly deployId: number | null;
      readonly after: number | null;
    }
  | Response
> {
  const authenticated = await authenticate(request, deps);
  if (authenticated instanceof Response) return authenticated;
  const url = new URL(request.url);
  const buildId = integer(url.searchParams.get('buildId'));
  const deployId = optionalInteger(url.searchParams.get('deployId'));
  const after = optionalInteger(url.searchParams.get('after'));
  if (buildId === null || deployId === false || after === false) {
    return refusal(
      400,
      'MALFORMED_REQUEST',
      'buildId, deployId, and after must be non-negative integers',
    );
  }

  const build = await authenticated.context.db.query.builds.findFirst({
    where: (builds, { eq }) => eq(builds.id, buildId),
    with: { component: true },
  });
  if (!build) {
    return refusal(404, 'NOT_FOUND', `there is no Build with id ${buildId}`);
  }
  if (deployId !== null) {
    const deploy = await authenticated.context.db.query.deploys.findFirst({
      where: (deploys, { and, eq }) =>
        and(eq(deploys.id, deployId), eq(deploys.buildId, buildId)),
    });
    if (!deploy) {
      return refusal(
        404,
        'NOT_FOUND',
        `there is no Deploy ${deployId} for Build ${buildId}`,
      );
    }
  }

  return {
    context: authenticated.context,
    component: build.component.name,
    componentId: build.componentId,
    buildId,
    deployId,
    after,
  };
}

async function upgradeAttempt(
  request: Request,
  server: Bun.Server<StreamSocketData>,
  deps: StreamDeps,
): Promise<Response | undefined> {
  const attempt = await resolveAttempt(request, deps);
  if (attempt instanceof Response) return attempt;
  const { context, componentId, buildId, deployId, after } = attempt;

  const upgraded = server.upgrade(request, {
    data: {
      kind: 'attempt',
      context,
      componentId,
      buildId,
      ...(deployId === null ? {} : { deployId }),
      cursor: after === null ? null : after,
      closed: false,
      unsubscribe: null,
    },
  });
  return upgraded
    ? undefined
    : refusal(400, 'MALFORMED_REQUEST', 'WebSocket upgrade failed');
}

/**
 * The attempt log as one `text/plain` document (§21: transport, no domain
 * logic). The same rows the socket pumps, read to the end through the same
 * reader, one log line per line and each status event as a bracketed line so
 * the document still says where each leg ended. Behind {@link resolveAttempt}
 * exactly as the upgrade is, so the `<a>` in the log pane is the whole client.
 */
export function attemptLogTextRoutes(
  deps: StreamDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return {
    [ATTEMPT_LOG_TEXT_PATH]: (request) => attemptLogText(request, deps),
  };
}

const TEXT_PAGE = 500;

async function attemptLogText(
  request: Request,
  deps: StreamDeps,
): Promise<Response> {
  const attempt = await resolveAttempt(request, deps);
  if (attempt instanceof Response) return attempt;
  const { context, component, componentId, buildId, deployId } = attempt;
  const ref = {
    componentId,
    buildId,
    ...(deployId === null ? {} : { deployId }),
  };

  const lines: string[] = [];
  let after: AttemptLogCursor | undefined;
  for (;;) {
    const page = await readAttemptStream(context.db, ref, {
      ...(after === undefined ? {} : { after }),
      limit: TEXT_PAGE,
    });
    for (const entry of page.entries) {
      lines.push(
        entry.type === 'log'
          ? entry.line
          : `[${entry.at.toISOString()} ${entry.attemptKind} ${entry.phase}${
              entry.resource === null ? '' : ` ${entry.resource}`
            }${entry.reason === null ? '' : ` ${entry.reason}`}]`,
      );
    }
    if (page.entries.length < TEXT_PAGE || page.cursor === null) break;
    after = page.cursor;
  }

  const name =
    deployId === null
      ? `${component}-build-${buildId}`
      : `${component}-deploy-${deployId}`;
  return new Response(lines.map((line) => `${line}\n`).join(''), {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'content-disposition': `inline; filename="${name}.txt"`,
    },
  });
}

async function upgradeRuntime(
  request: Request,
  server: Bun.Server<StreamSocketData>,
  deps: StreamDeps,
): Promise<Response | undefined> {
  const authenticated = await authenticate(request, deps);
  if (authenticated instanceof Response) return authenticated;
  const url = new URL(request.url);
  const componentId = url.searchParams.get('componentId');
  const targetId = url.searchParams.get('targetId');
  const after = url.searchParams.get('after');
  /** Which run, for the one kind whose output belongs to a run (§17). */
  const execution = url.searchParams.get('execution');
  // This value is concatenated into a query language on the far side — a Cloud
  // Logging filter, a label selector — so it is checked here, at the one place
  // it enters from a browser, rather than escaped at each of them. Unchecked it
  // is a read of the whole vessel's project: `AND` binds tighter than `OR`, so
  // `a" OR timestamp>="2020-01-01T00:00:00Z` makes a filter that matches every
  // entry the project has, other Apps' output and audit logs included, and the
  // lines land in the run pane of whoever asked.
  //
  // One DNS label — §9's {@link isLabel}, rather than a sixth copy of the same
  // grammar — because that is what everything Spindrift starts is called: a
  // Cloud Run execution name *is* validated as a label, and the Jobs this
  // adapter creates are named from a release name already shortened to 63.
  //
  // It is deliberately narrower than Kubernetes. A Job name is a DNS
  // *subdomain* — dots are legal, and the ceiling is 253 — and `executions()`
  // lists by label, so a foreign Job named `blog.nightly-1` can reach the
  // Recent runs card and be refused when its row is clicked. That is the trade
  // taken: a name Spindrift cannot have produced does not get to widen a
  // browser-controlled string on its way into two query languages, and a run
  // whose logs will not open is a smaller failure than one that opens
  // everyone's. Widening it means escaping at each concatenation site instead.
  //
  // `?execution=` is an empty string rather than `null`, which passes the "name
  // one" guard below, so it is refused here.
  if (execution !== null && !isLabel(execution)) {
    return refusal(400, 'MALFORMED_REQUEST', 'that is not a run name');
  }
  if (!componentId || !targetId) {
    return refusal(
      400,
      'MALFORMED_REQUEST',
      'componentId and targetId are required',
    );
  }

  const [component] = await authenticated.context.db
    .select({
      id: components.id,
      name: components.name,
      kind: components.kind,
      appId: components.appId,
    })
    .from(components)
    .where(eq(components.id, componentId))
    .limit(1);
  const [target] = await authenticated.context.db
    .select({ target: targets, vessel: vessels })
    .from(targets)
    // The boundary carries where this Target is, which the tail needs as much
    // as the surface's own facts.
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(targets.id, targetId))
    .limit(1);
  if (!component || !target) {
    return refusal(404, 'NOT_FOUND', 'the Component or Target does not exist');
  }
  const { target: surface, vessel } = target;
  // §17: a job has executions rather than a runtime tail, and the refusal that
  // used to end here is now answered by the executions it names — one of them
  // is the subject. Without one there is still nothing to follow: a job is not
  // running most of the time, and merging every run's output into one stream
  // would answer a question nobody asked.
  if (component.kind === 'job' && execution === null) {
    return refusal(
      409,
      'NO_RUNTIME',
      'a job has executions rather than a runtime tail: name one to read it',
    );
  }
  // And the other direction: a service has one output and it is not a run's.
  // Serving a named execution here would hand back the Component's whole tail
  // under a name that had been silently dropped.
  if (component.kind !== 'job' && execution !== null) {
    return refusal(
      409,
      'NO_RUNTIME',
      `${component.name} is a ${component.kind}, and only a job has runs`,
    );
  }
  const [placed] = await authenticated.context.db
    .select({ id: deploys.id })
    .from(deploys)
    .where(
      and(
        eq(deploys.componentId, component.id),
        eq(deploys.targetId, surface.id),
      ),
    )
    .limit(1);
  if (!placed || !hasTargetConnection(surface) || !hasVesselLocation(vessel)) {
    return refusal(
      409,
      'NO_RUNTIME',
      'this Component has no runtime on that Target',
    );
  }
  const adapter = authenticated.context.adapters.deploy(surface.adapter);
  if (adapter === null) {
    return refusal(
      409,
      'NO_RUNTIME',
      'this installation has no adapter for that Target',
    );
  }
  const [app] = await authenticated.context.db.query.apps.findMany({
    where: (apps, { eq }) => eq(apps.id, component.appId),
    limit: 1,
  });
  if (!app) {
    return refusal(404, 'NOT_FOUND', 'the Component App does not exist');
  }

  const upgraded = server.upgrade(request, {
    data: {
      kind: 'runtime',
      adapter,
      target: deployTargetOf(surface, vessel),
      subject: {
        app: app.name,
        component: component.name,
        ...(execution === null ? {} : { execution }),
      },
      cursor: after,
      closed: false,
    },
  });
  return upgraded
    ? undefined
    : refusal(400, 'MALFORMED_REQUEST', 'WebSocket upgrade failed');
}

async function upgradeFunctionLog(
  request: Request,
  server: Bun.Server<StreamSocketData>,
  deps: StreamDeps,
): Promise<Response | undefined> {
  const authenticated = await authenticate(request, deps);
  if (authenticated instanceof Response) return authenticated;
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  if (name === null || !FUNCTION_NAME_PATTERN.test(name)) {
    return refusal(
      400,
      'MALFORMED_REQUEST',
      'name must be a valid Function name',
    );
  }

  const row = await authenticated.context.db.query.functions.findFirst({
    where: (rows, { eq }) => eq(rows.name, name),
  });
  if (!row) {
    return refusal(404, 'NOT_FOUND', `there is no Function named '${name}'`);
  }

  const deployers = authenticated.context.adapters.functions?.() ?? null;
  const deployer = deployers?.[row.target as FunctionTarget] ?? null;
  if (deployer === null) {
    return refusal(
      409,
      'NOT_DEPLOYABLE',
      `this installation has no ${row.target} surface to tail '${name}' on`,
    );
  }

  const upgraded = server.upgrade(request, {
    data: {
      kind: 'function',
      name,
      deployer,
      abort: new AbortController(),
      closed: false,
    },
  });
  return upgraded
    ? undefined
    : refusal(400, 'MALFORMED_REQUEST', 'WebSocket upgrade failed');
}

export async function readStreamPage(
  data: StreamSocketData,
): Promise<StreamMessage> {
  if (data.kind === 'runtime') {
    return data.adapter.tail(data.target, data.subject, {
      ...(data.cursor === null ? {} : { after: data.cursor }),
      limit: 200,
    });
  }
  if (data.kind === 'function' || data.kind === 'kthx') {
    // A function-log socket runs its own `tail` loop from `open`, and a kthx
    // socket is driven by its client — neither is a page to read.
    throw new Error(`readStreamPage does not serve ${data.kind} sockets`);
  }

  const page = await readAttemptStream(
    data.context.db,
    {
      componentId: data.componentId,
      buildId: data.buildId,
      ...(data.deployId === undefined ? {} : { deployId: data.deployId }),
    },
    {
      ...(data.cursor === null ? {} : { after: data.cursor }),
      limit: 500,
    },
  );
  return {
    kind: 'attempt',
    entries: page.entries,
    cursor: page.cursor,
    terminal: page.entries.some((entry) => {
      if (entry.type !== 'status') return false;
      return data.deployId === undefined
        ? entry.attemptKind === 'build' &&
            (entry.phase === 'SUCCEEDED' || entry.phase === 'FAILED')
        : entry.attemptKind === 'deploy' &&
            (entry.phase === 'LIVE' || entry.phase === 'FAILED');
    }),
  };
}

export const streamWebSocket: Bun.WebSocketHandler<StreamSocketData> = {
  open(socket) {
    // A kthx socket waits to be told what to watch or join.
    if (socket.data.kind === 'kthx') return;
    // A function-log socket has no page to pump — it drives the deployer's
    // own `tail` generator for as long as the connection lives.
    if (socket.data.kind === 'function') {
      void tailFunctionLogs(socket.data, socket);
      return;
    }
    // Subscribe to in-process wake-ups so the pump fires immediately when
    // the web process itself writes an event (Transport shape).
    if (socket.data.kind === 'attempt') {
      socket.data.unsubscribe = onAttemptEvent(
        socket.data.componentId,
        () => void pump(socket),
      );
    }
    void pump(socket);
  },
  message(socket, message) {
    // The streams are server-to-client only: a cursor is established by the
    // authenticated URL. A kthx socket is the one that listens.
    if (socket.data.kind === 'kthx') {
      kthxSocket.message(socket, socket.data, message);
    }
  },
  close(socket) {
    if (socket.data.kind === 'kthx') {
      kthxSocket.close(socket, socket.data);
      return;
    }
    socket.data.closed = true;
    if (socket.data.kind === 'attempt') {
      socket.data.unsubscribe?.();
      socket.data.unsubscribe = null;
    } else if (socket.data.kind === 'function') {
      socket.data.abort.abort();
    }
  },
};

/**
 * The function-log socket's whole life: relay `deployer.tail` until the
 * caller aborts or the generator ends, one message per log line so a slow
 * consumer never waits on a batch.
 */
async function tailFunctionLogs(
  data: FunctionSocketData,
  socket: Bun.ServerWebSocket<StreamSocketData>,
): Promise<void> {
  try {
    for await (const entry of data.deployer.tail(
      data.name,
      data.abort.signal,
    )) {
      if (data.closed) return;
      socket.send(
        JSON.stringify({
          kind: 'function-log',
          entries: [entry],
        } satisfies FunctionLogPage),
      );
    }
  } catch (cause) {
    if (data.closed) return;
    socket.send(
      JSON.stringify({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      } satisfies StreamErrorMessage),
    );
    socket.close(1011, 'stream read failed');
  }
}

async function pump(
  socket: Bun.ServerWebSocket<StreamSocketData>,
): Promise<void> {
  // Neither a function-log socket nor a kthx one reaches `pump` — `open`
  // routes them elsewhere — but the type is shared, so this narrows the rest
  // of the function back to the two kinds `readStreamPage` serves.
  if (socket.data.kind === 'function' || socket.data.kind === 'kthx') return;
  if (socket.data.closed) return;
  try {
    const page = await readStreamPage(socket.data);
    if (page.kind === 'attempt') {
      socket.data.cursor = page.cursor;
      if (page.entries.length > 0 || page.terminal) {
        socket.send(JSON.stringify(page));
      }
      if (page.terminal) {
        socket.close(1000, 'terminal');
        return;
      }
    } else if (page.kind === 'none') {
      socket.send(JSON.stringify(page));
      socket.close(1000, 'no runtime');
      return;
    } else if (page.kind === 'error') {
      socket.send(JSON.stringify(page));
      socket.close(1011, 'stream read failed');
      return;
    } else if (page.kind === 'function-log') {
      // Unreachable: `socket.data.kind !== 'function'` here, so
      // `readStreamPage` never returns this page. Typed out rather than
      // asserted away, so a future page kind cannot fall through silently.
      throw new Error('a runtime/attempt pump received a function-log page');
    } else {
      socket.data.cursor = page.cursor;
      if (page.entries.length > 0) socket.send(JSON.stringify(page));
    }
  } catch (cause) {
    socket.send(
      JSON.stringify({
        kind: 'error',
        message: cause instanceof Error ? cause.message : String(cause),
      } satisfies StreamErrorMessage),
    );
    socket.close(1011, 'stream read failed');
    return;
  }
  if (!socket.data.closed) setTimeout(() => void pump(socket), 750);
}

function integer(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalInteger(value: string | null): number | null | false {
  if (value === null) return null;
  return integer(value) ?? false;
}

function refusal(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, failure: { code, message } }, { status });
}
