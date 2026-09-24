/**
 * What the production and dev entries share: load the manifest, assemble the
 * route table, and listen. They differ only in how the client is served.
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
import { BOSUN_SECRET_VAR } from './bosun-route.ts';
import { inClusterHostnames, scopeToHost } from './host-scope.ts';
import { type ClientRoute, webRoutes } from './routes.ts';
import { type StreamSocketData, streamWebSocket } from './streams.ts';

/**
 * Read from the installation Secret, never the manifest, which operators share.
 * Unset means enrolment is impossible.
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
 * WebSocket upgrades need the `server` argument passed through, and return
 * `undefined` once Bun takes the socket. Losing either breaks every stream.
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
              // An upgraded WebSocket returns no Response, so it counts as 101.
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

  // Re-read per request because `configureInstallation` writes the row at
  // runtime. The adapters are rebuilt only when the document changed.
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

  // Read once: the hostname is the passkey relying-party id, so changing it
  // needs a restart.
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

  // The `github_app` row it opens is re-read per request: the setup route
  // writes it at runtime.
  const keyring = CredentialKeyring.fromEnvironment(Bun.env);

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
      // Agent tokens only: `/mcp` never reads the session cookie or a Gateway
      // header.
      authenticate: async (request) => {
        const principal = await resolveAgentToken(request, auth);
        return principal === null
          ? { kind: 'anonymous' as const }
          : { kind: 'authenticated' as const, principal };
      },
      context: commandContext,
    },
  );

  const instrumented = instrumentRoutes(rawRoutes);

  const server = Bun.serve<StreamSocketData>({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    // Development's client is an HTMLBundle, which no handler can wrap.
    routes: development
      ? instrumented
      : scopeToHost(instrumented, {
          controlPlane: manifest.controlPlane.hostname,
          public: manifest.controlPlane.publicHostname,
          inCluster: inClusterHostnames(Bun.env),
        }),
    websocket: streamWebSocket,
    // Caps what anybody can post to a public route.
    maxRequestBodySize: 32 * 1024 * 1024,
  });

  logInfo(`spindrift web → ${server.url} (${manifest.installation.name})`, {
    url: String(server.url),
    installation: manifest.installation.name,
  });
}
