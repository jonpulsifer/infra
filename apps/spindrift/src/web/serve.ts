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
import { resolveAgentToken } from '../auth/session.ts';
import { type Principal, systemClock } from '../commands/types.ts';
import { assertTrustedGatewayBoundary } from '../config/manifest.ts';
import {
  currentStoredManifest,
  loadStoredManifest,
} from '../config/manifest-store.ts';
import { CredentialKeyring } from '../crypto/credential-envelope.ts';
import { createDb } from '../db/client.ts';
import {
  GitHubAppAuth,
  githubAppWebhookSecret,
} from '../integrations/github/app-auth.ts';
import { type KthxDeps, kthxZone, withKthxHost } from '../kthx/serve.ts';
import { sourceDepotFor } from '../storage/archives.ts';
import { BOSUN_SECRET_VAR } from './bosun-route.ts';
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
   * The configuration a command runs against, current as of this request.
   *
   * `configureInstallation` writes the row, so a process-lifetime copy would
   * mean an operator watching a form save a value nothing then reads. The read
   * is one `select` per command; the adapters are rebuilt only when the
   * document actually changed, which is what makes doing this per request
   * affordable — `createAdapterRegistry` is pure assembly whose credentials are
   * providers called per request, so rebuilding opens nothing.
   *
   * Deliberately **not** current: `auth` below. `controlPlane.hostname` is the
   * passkey relying-party id, and a ceremony is scoped to the origin it began
   * at — re-reading it mid-session would invalidate credentials rather than
   * update them. Changing where an installation is served is a restart.
   */
  let current = { manifest, adapters };
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
    };
    return current;
  };

  /**
   * What every command runs against, whichever transport reached it.
   *
   * One function rather than one per surface: the dispatch endpoint and `/mcp`
   * differ in who they will accept and in nothing else, and two copies of this
   * would be two chances for a command to see a different world depending on
   * which door it came through.
   */
  const commandContext = async (principal: Principal) => {
    const installation = await installationNow();
    return {
      principal,
      clock: systemClock,
      db,
      adapters: installation.adapters,
      manifest: installation.manifest,
    };
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

  /**
   * The keyring that opens the sealed `github_app` row. Resolved once — it is
   * an installation-Secret value, not a row — but everything opened *with* it
   * is read per delivery / per request, because the row itself is written
   * mid-flight by the setup route.
   */
  const keyring = CredentialKeyring.fromEnvironment(Bun.env);

  /**
   * kthx sites stage into the same depot `/internal/upload` does, read per
   * request through the accessor above for the same reason the routes do.
   */
  const kthx: KthxDeps = {
    db,
    zone: kthxZone(Bun.env),
    depot: async () => sourceDepotFor((await installationNow()).manifest),
  };

  const rawRoutes = webRoutes(
    client,
    {
      authenticate: (request) => authenticateRequest(request, auth),
      context: commandContext,
    },
    auth,
    {
      db,
      clock: systemClock,
      secret: () => githubAppWebhookSecret(db, keyring),
      // Same accessor `context` above reads through: current as of this
      // request, rebuilt only when `configureInstallation` actually changed
      // something.
      current: installationNow,
    },
    {
      db,
      clock: systemClock,
      secret: Bun.env[BOSUN_SECRET_VAR]?.trim() || null,
    },
    {
      authenticate: (request) => authenticateRequest(request, auth),
      auth: async () => {
        const installation = await installationNow();
        return new GitHubAppAuth({
          db,
          clock: systemClock,
          keyring,
          env: Bun.env,
          apiBaseUrl: installation.manifest.github.apiBaseUrl,
          webBaseUrl: installation.manifest.github.webBaseUrl,
          controlPlaneHostname: installation.manifest.controlPlane.hostname,
          installationName: installation.manifest.installation.name,
          appSlug: installation.manifest.github.appSlug ?? null,
          webhookUrl: installation.manifest.github.webhookUrl ?? null,
        });
      },
    },
    { db, current: installationNow },
    {
      // Deliberately *not* `authenticateRequest`: that resolver reads the
      // session cookie and, where a Gateway is configured, a trusted header.
      // Neither belongs on `/mcp`. An agent presents a token it was minted,
      // and a cookie copied out of a browser must not open this surface —
      // `src/auth/session.ts` carries why.
      authenticate: async (request) => {
        const principal = await resolveAgentToken(request, auth);
        return principal === null
          ? { kind: 'anonymous' as const }
          : { kind: 'authenticated' as const, principal };
      },
      context: commandContext,
    },
    kthx,
  );

  const server = Bun.serve<StreamSocketData>({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    // A kthx `Host` is answered before any path in the table is consulted;
    // the wrapper sits inside the instrumentation so those requests are
    // counted under the path they would otherwise have reached.
    routes: instrumentRoutes(withKthxHost(rawRoutes, kthx)),
    websocket: streamWebSocket,
    // The abuse floor for a surface anybody can post bytes to. A kthx archive
    // is refused above 25 MiB before this is reached; a console upload has
    // never been near it.
    maxRequestBodySize: 32 * 1024 * 1024,
  });

  logInfo(`spindrift web → ${server.url} (${manifest.installation.name})`, {
    url: String(server.url),
    installation: manifest.installation.name,
  });
}
