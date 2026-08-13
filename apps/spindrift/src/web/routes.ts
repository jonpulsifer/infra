/**
 * The `web` process's whole route table, in one testable function.
 *
 * This module exists because of where the drift actually lives. Task 36b's
 * acceptance — "no route exists that is not a registry command" — is trivially
 * true of `commandRoutes`, which is generated and could not fail it. The place a
 * hand-authored route would appear is the table that *spreads* it, and that used
 * to be inline in `server.ts` next to a top-level `Bun.serve` no test can
 * import. So the table moved here and the entries call it.
 *
 * Eleven kinds of route exist, and three of the eleven are generated:
 *
 * 1. **Commands**, from the registry (`dispatch.ts`).
 * 2. **The client**, from whatever built it — `bundle.ts` reading a directory in
 *    production, Bun's HTML import in development. Both are generated; neither
 *    is a path anybody typed.
 * 3. **Auth**, from `src/auth/routes.ts` — generated from that module's own
 *    closed tuple of acts. It contains the pre-session acts that *produce* a
 *    principal and passkey-rooted credential administration; neither belongs
 *    in the product command registry.
 * 4. **Upload**, the archive upload boundary (`upload.ts`) — session-authenticated
 *    like a command, but it takes bytes rather than JSON, so it cannot be one.
 * 5. **Streams**, the two authenticated, purpose-specific WebSocket upgrades.
 * 6. **The webhook** (`webhook-route.ts`), the one route with no session at
 *    all — its authentication is the GitHub HMAC over the raw body, not a
 *    cookie, so it cannot go through `DispatchDeps.authenticate` either.
 * 7. **Bosun** (`bosun-route.ts`), the other route with no session — a
 *    warm-pool poller cannot hold one either, so it carries an installation
 *    Secret bearer token the same way the webhook carries a signature.
 * 8. **{@link HEALTH_PATH}**, a liveness probe that consults nothing.
 * 9. **{@link READY_PATH}**, a readiness probe that does — see below.
 * 10. **GitHub setup** (`github-setup-route.ts`), where the App-creation and
 *     installation flows land. Session-authenticated like a command, but it is
 *     a redirect target GitHub reaches with GET and a query string, so it
 *     cannot be one.
 * 11. **The status page** (`status-route.ts`), the lowest-precedence entry in
 *     the table and the only one that reads the `Host` header rather than the
 *     path — §9's page for an App address that nothing is serving yet. It is
 *     last here as well as least specific, so the file reads in the order
 *     `Bun.serve` matches in.
 *
 * A further hand-authored route is a decision somebody has to make on purpose,
 * in this file, against a test that names it.
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
import { type StatusRouteDeps, statusRoutes } from './status-route.ts';
import { streamRoutes } from './streams.ts';
import { uploadRoutes } from './upload.ts';
import { type WebhookRouteDeps, webhookRoutes } from './webhook-route.ts';

/**
 * Liveness: whether this process is still running.
 *
 * A constant rather than a handler on purpose: a probe that can consult
 * something is a probe that can be wrong about something, and §21's "no route
 * may contain domain logic" is easiest to keep when there is no logic to keep
 * out. Deliberately answers "yes" even while the database is unreachable — a
 * kubelet that restarted this pod for that would kill the one thing capable of
 * reconnecting once Postgres comes back. {@link READY_PATH} is where that
 * question actually gets asked.
 */
export const HEALTH_PATH = '/healthz';

/**
 * Readiness: whether this pod should currently receive traffic.
 *
 * Unlike {@link HEALTH_PATH} this does consult something — a `select 1`
 * through the same pool every command uses — because "is the process up" and
 * "can it actually do anything" are different questions, and only the second
 * one is the Service's to act on. A failure here takes the pod out of
 * rotation without restarting it, which is the correct response to a database
 * that is down and will recover on its own.
 */
export const READY_PATH = '/readyz';

/** {@link READY_PATH}'s handler: the one hand-authored route that reads the database. */
async function readyResponse(db: Database): Promise<Response> {
  try {
    await db.execute(sql`select 1`);
    return new Response('ok\n');
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return new Response(`not ready: ${detail}\n`, { status: 503 });
  }
}

/**
 * What a client route may be: a built file's `Response` in production, or Bun's
 * `HTMLBundle` in development. Narrow on purpose — a *handler* here would be a
 * place to put logic, and the client half of this table is meant to be inert.
 */
export type ClientRoute = Response | Bun.HTMLBundle;

/**
 * Assemble the table `Bun.serve` is given.
 *
 * The client's routes are a parameter rather than an import because the two
 * entries build them differently — and the difference is the whole point of the
 * split. `server.ts` reads a directory that was built into the image;
 * `dev.ts` imports the HTML and lets Bun compile it on the fly. Passing them in
 * also keeps this function callable from a test, which importing either would
 * not.
 */
export function webRoutes<Client extends Record<string, ClientRoute>>(
  client: Client,
  deps: DispatchDeps,
  auth: EnrolmentDeps & GatewayDeps,
  webhook: WebhookRouteDeps,
  bosun: BosunRouteDeps,
  githubSetup: GitHubSetupRouteDeps,
  status: StatusRouteDeps,
) {
  return {
    ...client,
    [HEALTH_PATH]: new Response('ok\n'),
    [READY_PATH]: () => readyResponse(auth.db),
    ...authRoutes(auth),
    ...commandRoutes(deps),
    ...streamRoutes(deps),
    ...uploadRoutes(deps),
    ...webhookRoutes(webhook),
    ...bosunRoutes(bosun),
    ...githubSetupRoutes(githubSetup),
    ...statusRoutes(status),
  };
}
