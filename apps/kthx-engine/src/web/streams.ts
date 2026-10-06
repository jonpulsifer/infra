/**
 * The authenticated browser streams: attempt events, runtime output and a
 * Function's log tail. Separate routes keep build output apart from stdout.
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
  /** Called per connection: configuration changes at runtime. */
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

export type StreamSocketData =
  | AttemptSocketData
  | RuntimeSocketData
  | FunctionSocketData;

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
 * Checks the session, then that the Build exists and a named Deploy is one of
 * its. Shared by the upgrade and the text document.
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

/** The rows the attempt socket pumps, read to the end as one document. */
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
  const execution = url.searchParams.get('execution');
  // Concatenated unescaped into a logging filter and a label selector, so it
  // must be one DNS label. An empty `?execution=` is refused here too.
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
    .innerJoin(vessels, eq(targets.vesselId, vessels.id))
    .where(eq(targets.id, targetId))
    .limit(1);
  if (!component || !target) {
    return refusal(404, 'NOT_FOUND', 'the Component or Target does not exist');
  }
  const { target: surface, vessel } = target;
  // A job's output belongs to its runs, so the caller must name one.
  if (component.kind === 'job' && execution === null) {
    return refusal(
      409,
      'NO_RUNTIME',
      'a job has executions rather than a runtime tail: name one to read it',
    );
  }
  // Only a job has runs; a service would silently ignore the name.
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
  if (data.kind === 'function') {
    // A function-log socket runs its own `tail` loop from `open`.
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
    // Relays the deployer's own `tail` generator in place of the pump.
    if (socket.data.kind === 'function') {
      void tailFunctionLogs(socket.data, socket);
      return;
    }
    // Wakes the pump at once when this process writes an event.
    if (socket.data.kind === 'attempt') {
      socket.data.unsubscribe = onAttemptEvent(
        socket.data.componentId,
        () => void pump(socket),
      );
    }
    void pump(socket);
  },
  message() {
    // Server-to-client only: the cursor comes from the authenticated URL.
  },
  close(socket) {
    socket.data.closed = true;
    if (socket.data.kind === 'attempt') {
      socket.data.unsubscribe?.();
      socket.data.unsubscribe = null;
    } else if (socket.data.kind === 'function') {
      socket.data.abort.abort();
    }
  },
};

/** One message per log line, until the caller aborts or the generator ends. */
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
  // `open` routes function-log sockets elsewhere; this narrows the type.
  if (socket.data.kind === 'function') return;
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
      // Unreachable; thrown so this kind never reaches the `stream` branch.
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
