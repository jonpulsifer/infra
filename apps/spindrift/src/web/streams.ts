/**
 * The two authenticated browser streams (§17): terminating attempt events and
 * non-terminating runtime output. Their routes, cursors, and payloads remain
 * distinct so build output can never be presented as application stdout.
 */
import { and, eq } from 'drizzle-orm';
import type {
  DeployAdapter,
  DeployTarget,
  RuntimeLogPage,
  RuntimeLogSubject,
} from '../adapters/deploy/contract.ts';
import type { RequestAuthentication } from '../auth/types.ts';
import type { CommandContext, Principal } from '../commands/types.ts';
import { onAttemptEvent } from '../db/notify.ts';
import { components, deploys, targets } from '../db/schema.ts';
import {
  type AttemptLogCursor,
  type AttemptLogEntry,
  readAttemptStream,
} from '../domain/attempt-log.ts';

export const ATTEMPT_STREAM_PATH = '/internal/streams/build-attempt';
export const RUNTIME_STREAM_PATH = '/internal/streams/runtime-log';
export const STREAM_PATHS = [ATTEMPT_STREAM_PATH, RUNTIME_STREAM_PATH] as const;

export interface StreamDeps {
  authenticate(request: Request): Promise<RequestAuthentication>;
  context(principal: Principal): CommandContext;
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

export type StreamSocketData = AttemptSocketData | RuntimeSocketData;

export interface AttemptStreamMessage {
  readonly kind: 'attempt';
  readonly entries: readonly AttemptLogEntry[];
  readonly cursor: AttemptLogCursor | null;
  readonly terminal: boolean;
}

export interface StreamErrorMessage {
  readonly kind: 'error';
  readonly message: string;
}

export type RuntimeStreamMessage = RuntimeLogPage | StreamErrorMessage;
export type StreamMessage = AttemptStreamMessage | RuntimeStreamMessage;

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
    context: deps.context(authentication.principal),
  };
}

async function upgradeAttempt(
  request: Request,
  server: Bun.Server<StreamSocketData>,
  deps: StreamDeps,
): Promise<Response | undefined> {
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

  const upgraded = server.upgrade(request, {
    data: {
      kind: 'attempt',
      context: authenticated.context,
      componentId: build.componentId,
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
    .select()
    .from(targets)
    .where(eq(targets.id, targetId))
    .limit(1);
  if (!component || !target) {
    return refusal(404, 'NOT_FOUND', 'the Component or Target does not exist');
  }
  if (component.kind === 'job') {
    return refusal(
      409,
      'NO_RUNTIME',
      'a job has executions rather than a runtime tail',
    );
  }
  const [placed] = await authenticated.context.db
    .select({ id: deploys.id })
    .from(deploys)
    .where(
      and(
        eq(deploys.componentId, component.id),
        eq(deploys.targetId, target.id),
      ),
    )
    .limit(1);
  if (!placed || target.connection === null) {
    return refusal(
      409,
      'NO_RUNTIME',
      'this Component has no runtime on that Target',
    );
  }
  const adapter = authenticated.context.adapters.deploy(target.adapter);
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
      target: {
        name: target.name,
        adapter: target.adapter,
        connection: target.connection,
      },
      subject: { app: app.name, component: component.name },
      cursor: after,
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
  message() {
    // Server-to-client only. A cursor is established by the authenticated URL.
  },
  close(socket) {
    socket.data.closed = true;
    if (socket.data.kind === 'attempt') {
      socket.data.unsubscribe?.();
      socket.data.unsubscribe = null;
    }
  },
};

async function pump(
  socket: Bun.ServerWebSocket<StreamSocketData>,
): Promise<void> {
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
