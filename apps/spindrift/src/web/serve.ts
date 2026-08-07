/**
 * Everything the two entries share: validate the manifest, assemble the table,
 * listen.
 *
 * It exists so `server.ts` and `dev.ts` differ in exactly one expression — how
 * the client is served — rather than in two copies of a `Bun.serve` call that
 * would drift apart in the parts that must not differ.
 *
 * The three dependencies below are the whole of what the process is:
 *
 * - **`session`** resolves the opaque cookie to a principal, or to nobody. A
 *   command route with nobody behind it answers 401, which is §21's
 *   session-authenticated-only surface working rather than a boundary that is
 *   not built.
 * - **`context`** is built per request, after a principal exists, and carries
 *   the injected clock, the database, the manifest, and the adapters this
 *   installation actually has (`src/adapters/registry.ts`).
 * - **`auth`** is the one surface reachable without a session, because it is
 *   what produces one. `src/auth/routes.ts` carries why it cannot be a command.
 */
import { createAdapterRegistry } from '../adapters/registry.ts';
import type { EnrolmentDeps } from '../auth/enrol.ts';
import { authenticateRequest, type GatewayDeps } from '../auth/gateway.ts';
import { systemClock } from '../commands/types.ts';
import { toAuthoredManifest } from '../config/manifest.schema.ts';
import {
  assertTrustedGatewayBoundary,
  loadManifestIfPresent,
} from '../config/manifest.ts';
import {
  currentStoredManifest,
  diffManifestPaths,
  loadStoredManifest,
} from '../config/manifest-store.ts';
import { createDb } from '../db/client.ts';
import { type ClientRoute, webRoutes } from './routes.ts';
import { type StreamSocketData, streamWebSocket } from './streams.ts';
import { WEBHOOK_SECRET_VAR } from './webhook-route.ts';

/**
 * Where the enrolment token arrives.
 *
 * The installation Secret, and deliberately **not** the installation manifest:
 * the manifest describes an installation and is the document §20 asks an
 * operator to write and hand around, while this is the credential that claims
 * one. Absent is a legal state — enrolment is then impossible, which is the
 * right posture for an installation nobody has been given the key to.
 */
export const ENROLMENT_TOKEN_VAR = 'SPINDRIFT_ENROLMENT_TOKEN';

import {
  httpRequestCounter,
  httpRequestDuration,
  initTelemetry,
  logInfo,
  tracer,
} from '../telemetry/index.ts';

/**
 * Wrap every handler in a span and the two HTTP metrics.
 *
 * Two things it must not change about a handler, both of which the WebSocket
 * upgrades depend on: `Bun.serve` calls a route with `(request, server)` and the
 * upgrade handlers need that second argument, and a handler that upgraded
 * returns `undefined` rather than a `Response` because Bun has taken the socket.
 * Dropping either turns every stream into a 500.
 */
export function instrumentRoutes<T extends Record<string, any>>(routes: T): T {
  const instrumented: Record<string, any> = {};
  for (const [path, handler] of Object.entries(routes)) {
    if (typeof handler === 'function') {
      instrumented[path] = async (
        req: Request,
        server: Bun.Server<StreamSocketData>,
      ) => {
        const startTime = Date.now();
        return tracer.startActiveSpan(
          `HTTP ${req.method} ${path}`,
          async (span: any) => {
            span.setAttribute('http.method', req.method);
            span.setAttribute('http.target', path);

            try {
              const res = await (
                handler as (
                  r: Request,
                  s: Bun.Server<StreamSocketData>,
                ) => Promise<Response | undefined> | Response | undefined
              )(req, server);
              const durationSec = (Date.now() - startTime) / 1000;
              // An upgraded WebSocket has no Response to report on. 101 is what
              // it is, and it keeps the metric honest rather than counting a
              // successful upgrade as a 200 that never went out.
              const status = res?.status ?? 101;

              httpRequestCounter.add(1, { path, status: String(status) });
              httpRequestDuration.record(durationSec, {
                path,
                status: String(status),
              });

              span.setAttribute('http.status_code', status);
              span.setStatus({ code: status < 400 ? 1 : 2 });
              span.end();
              return res;
            } catch (err) {
              const durationSec = (Date.now() - startTime) / 1000;
              httpRequestCounter.add(1, { path, status: '500' });
              httpRequestDuration.record(durationSec, {
                path,
                status: '500',
              });

              span.setStatus({ code: 2, message: String(err) });
              span.recordException(
                err instanceof Error ? err : new Error(String(err)),
              );
              span.end();
              throw err;
            }
          },
        );
      };
    } else {
      instrumented[path] = handler;
    }
  }
  return instrumented as T;
}

export async function start(
  client: Record<string, ClientRoute>,
  { development }: { development: boolean },
): Promise<void> {
  initTelemetry('web');

  const db = createDb();
  const manifest = await loadStoredManifest(db);
  assertTrustedGatewayBoundary(manifest);
  const adapters = createAdapterRegistry({
    manifest,
    db,
    clock: systemClock,
  });

  /**
   * The mounted declaration, read once and held for the life of the process.
   *
   * `loadStoredManifest` already read this file at boot to decide whether to
   * seed from it, and already logs when it disagrees with what got stored —
   * this is a second, best-effort read of the same file so `declarationDivergence`
   * below can answer the same question on demand rather than only once, to a
   * log line, at the moment nobody was watching. It also rides the context
   * whole, as `declaration` itself — not only as the paths it disagrees at —
   * which is what lets a surface put it on the stored row without a second
   * reader (`src/commands/installation/get.ts` and `configure.ts` say why that
   * is safe). `null` for "unreadable" as well as "absent": an invalid
   * declaration is already reported by that boot warning, and this is a
   * display concern, not a second place to be fatal about it. Not re-read per
   * request — the ConfigMap volume it lives on does not change without a pod
   * restart in the ordinary case, which is the same reasoning `relyingParty`
   * below rests on.
   */
  const declaration = await loadManifestIfPresent().catch(() => null);

  /**
   * The configuration a command runs against, current as of this request.
   *
   * `configureInstallation` writes the row, so a process-lifetime copy would
   * mean an operator watching a form save a value nothing then reads. The read
   * is one `select` per command; the adapters are rebuilt only when the
   * document actually changed, which is what makes doing this per request
   * affordable — `createAdapterRegistry` is pure assembly whose credentials are
   * providers called per request, so rebuilding opens nothing. `declarationDivergence`
   * is recomputed on that same change, against the one-time `declaration`
   * above — cheap, because `diffManifestPaths` is a pure walk over two
   * documents already in memory.
   *
   * Deliberately **not** current: `auth` below. `controlPlane.hostname` is the
   * passkey relying-party id, and a ceremony is scoped to the origin it began
   * at — re-reading it mid-session would invalidate credentials rather than
   * update them. Changing where an installation is served is a restart.
   */
  let current = {
    manifest,
    adapters,
    declarationDivergence:
      declaration === null
        ? []
        : diffManifestPaths(declaration, toAuthoredManifest(manifest)),
  };
  const installationNow = async () => {
    const stored = await currentStoredManifest(db);
    if (stored === null || Bun.deepEquals(stored, current.manifest, true)) {
      return current;
    }
    current = {
      manifest: stored,
      adapters: createAdapterRegistry({
        manifest: stored,
        db,
        clock: systemClock,
      }),
      declarationDivergence:
        declaration === null
          ? []
          : diffManifestPaths(declaration, toAuthoredManifest(stored)),
    };
    return current;
  };

  const auth: EnrolmentDeps & GatewayDeps = {
    db,
    clock: systemClock,
    relyingParty: {
      id: manifest.controlPlane.hostname,
      name: manifest.installation.name,
      origin: `https://${manifest.controlPlane.hostname}`,
    },
    enrolmentToken: Bun.env[ENROLMENT_TOKEN_VAR]?.trim() || null,
    gateway: manifest.auth.gateway,
  };

  const rawRoutes = webRoutes(
    client,
    {
      authenticate: (request) => authenticateRequest(request, auth),
      context: async (principal) => {
        const installation = await installationNow();
        return {
          principal,
          clock: systemClock,
          db,
          adapters: installation.adapters,
          manifest: installation.manifest,
          declaration,
          declarationDivergence: installation.declarationDivergence,
        };
      },
    },
    auth,
    {
      db,
      clock: systemClock,
      secret: Bun.env[WEBHOOK_SECRET_VAR]?.trim() || null,
      // Same accessor `context` above reads through: current as of this
      // request, rebuilt only when `configureInstallation` actually changed
      // something.
      current: installationNow,
    },
  );

  const server = Bun.serve<StreamSocketData>({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    routes: instrumentRoutes(rawRoutes),
    websocket: streamWebSocket,
  });

  logInfo(`spindrift web → ${server.url} (${manifest.installation.name})`, {
    url: String(server.url),
    installation: manifest.installation.name,
  });
}
