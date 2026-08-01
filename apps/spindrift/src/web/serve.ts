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
import { assertTrustedGatewayBoundary } from '../config/manifest.ts';
import { loadStoredManifest } from '../config/manifest-store.ts';
import { createDb } from '../db/client.ts';
import { type ClientRoute, webRoutes } from './routes.ts';
import { type StreamSocketData, streamWebSocket } from './streams.ts';

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

function instrumentRoutes<T extends Record<string, any>>(routes: T): T {
  const instrumented: Record<string, any> = {};
  for (const [path, handler] of Object.entries(routes)) {
    if (typeof handler === 'function') {
      instrumented[path] = async (req: Request) => {
        const startTime = Date.now();
        return tracer.startActiveSpan(
          `HTTP ${req.method} ${path}`,
          async (span: any) => {
            span.setAttribute('http.method', req.method);
            span.setAttribute('http.target', path);

            try {
              const res = await (
                handler as (r: Request) => Promise<Response> | Response
              )(req);
              const durationSec = (Date.now() - startTime) / 1000;
              const status = res.status ?? 200;

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

  const auth: EnrolmentDeps & GatewayDeps = {
    db,
    clock: systemClock,
    relyingParty: {
      id: manifest.controlPlane.hostname,
      name: manifest.installation,
      origin: `https://${manifest.controlPlane.hostname}`,
    },
    enrolmentToken: Bun.env[ENROLMENT_TOKEN_VAR]?.trim() || null,
    gateway: manifest.auth.gateway,
  };

  const rawRoutes = webRoutes(
    client,
    {
      authenticate: (request) => authenticateRequest(request, auth),
      context: (principal) => ({
        principal,
        clock: systemClock,
        db,
        adapters,
        manifest,
      }),
    },
    auth,
  );

  const server = Bun.serve<StreamSocketData>({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    routes: instrumentRoutes(rawRoutes),
    websocket: streamWebSocket,
  });

  logInfo(`spindrift web → ${server.url} (${manifest.installation})`, {
    url: String(server.url),
    installation: manifest.installation,
  });
}
