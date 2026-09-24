/**
 * The web process's route table, as a function a test can import. A new
 * hand-authored route is a decision made on purpose, in this file, against the
 * route test that names it.
 */

import { sql } from 'drizzle-orm';
import type { EnrolmentDeps } from '../auth/enrol.ts';
import type { GatewayDeps } from '../auth/gateway.ts';
import { authRoutes } from '../auth/routes.ts';
import type { Database } from '../db/client.ts';
import { type BosunRouteDeps, bosunRoutes } from './bosun-route.ts';
import { commandRoutes, type DispatchDeps } from './dispatch.ts';
import {
  type GitHubSetupRouteDeps,
  githubSetupRoutes,
} from './github-setup-route.ts';
import { type McpRouteDeps, mcpRoutes } from './mcp-route.ts';
import { type StatusRouteDeps, statusRoutes } from './status-route.ts';
import { attemptLogTextRoutes, streamRoutes } from './streams.ts';
import { uploadRoutes } from './upload.ts';
import { type WebhookRouteDeps, webhookRoutes } from './webhook-route.ts';

/**
 * Liveness answers ok while the database is down, so the kubelet never restarts
 * the process that would reconnect.
 */
export const HEALTH_PATH = '/healthz';

/**
 * Readiness fails while the database is down, which takes the pod out of
 * rotation without a restart.
 */
export const READY_PATH = '/readyz';

async function readyResponse(db: Database): Promise<Response> {
  try {
    await db.execute(sql`select 1`);
    return new Response('ok\n');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Response(`not ready: ${detail}\n`, { status: 503 });
  }
}

/** A built file in production, or Bun's `HTMLBundle` in development. */
export type ClientRoute = Response | Bun.HTMLBundle;

/**
 * Client routes are a parameter: `server.ts` reads a built directory and
 * `dev.ts` imports the HTML for Bun to compile.
 */
export function webRoutes<Client extends Record<string, ClientRoute>>(
  client: Client,
  deps: DispatchDeps,
  auth: EnrolmentDeps & GatewayDeps,
  webhook: WebhookRouteDeps,
  bosun: BosunRouteDeps,
  githubSetup: GitHubSetupRouteDeps,
  status: StatusRouteDeps,
  mcp: McpRouteDeps,
) {
  return {
    ...client,
    [HEALTH_PATH]: new Response('ok\n'),
    [READY_PATH]: () => readyResponse(auth.db),
    ...authRoutes(auth),
    ...commandRoutes(deps),
    ...streamRoutes(deps),
    ...attemptLogTextRoutes(deps),
    ...uploadRoutes(deps),
    ...webhookRoutes(webhook),
    ...bosunRoutes(bosun),
    ...githubSetupRoutes(githubSetup),
    ...mcpRoutes(mcp),
    ...statusRoutes(status),
  };
}
