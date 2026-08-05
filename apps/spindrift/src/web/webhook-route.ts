/**
 * The signed repository webhook, mounted (§15, §21).
 *
 * `src/integrations/github/webhook.ts` is the verify-then-classify handler;
 * this is the one route that reaches it, following `upload.ts`'s shape rather
 * than `dispatch.ts`'s — a delivery carries no session, so there is no
 * `deps.authenticate` here at all. **The signature is the only
 * authentication this route has**, which is why {@link WEBHOOK_SECRET_VAR}
 * absent refuses every delivery before `handleWebhookDelivery` ever runs,
 * the same posture `ENROLMENT_TOKEN_VAR` takes in `serve.ts` for the same
 * reason: an installation nobody has configured a secret for cannot have
 * signed anything, so there is nothing here for a delivery to prove.
 *
 * A verified delivery is classified and handed to `repo-loop.ts`'s
 * `applyWebhookDelivery` — the loop's own latency optimization, not a second
 * reconciliation path — and the passes it returns go straight to
 * `auto-deploy.ts`'s `dispatchAutoDeploys`. The poll loop's periodic pass
 * calls the same function over the same shape of value, which is what keeps
 * this route a shortcut: every branch here either does what the next poll
 * would have done anyway, or does nothing.
 */
import type { AdapterRegistry, Clock } from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import {
  EVENT_HEADER,
  handleWebhookDelivery,
  SIGNATURE_HEADER,
  type WebhookDelivery,
  WebhookRejected,
  type WebhookRejectionCode,
} from '../integrations/github/webhook.ts';
import { dispatchAutoDeploys } from '../reconciler/auto-deploy.ts';
import { applyWebhookDelivery } from '../reconciler/repo-loop.ts';

export const WEBHOOK_PATH = '/internal/github/webhook';

/**
 * Where the webhook secret arrives — mirrors `serve.ts`'s
 * `ENROLMENT_TOKEN_VAR`: an installation Secret key, read once at boot, never
 * from the manifest an operator authors and hands around.
 */
export const WEBHOOK_SECRET_VAR = 'SPINDRIFT_GITHUB_WEBHOOK_SECRET';

export interface WebhookRouteDeps {
  readonly db: Database;
  readonly clock: Clock;
  /** `null` when this installation has no secret configured. */
  readonly secret: string | null;
  /**
   * Current as of this request — mirrors `DispatchDeps.context`'s reasoning:
   * `configureInstallation` writes the row this route would otherwise never
   * re-read.
   */
  current(): Promise<{
    readonly adapters: AdapterRegistry;
    readonly manifest: InstallationManifest;
  }>;
}

export function webhookRoutes(
  deps: WebhookRouteDeps,
): Record<string, (request: Request) => Promise<Response>> {
  return {
    [WEBHOOK_PATH]: (request: Request) => handleWebhook(request, deps),
  };
}

function refuse(status: number, code: string, message: string): Response {
  return Response.json({ ok: false, failure: { code, message } }, { status });
}

/** The status a rejection code reads as — an auth failure, or a bad request. */
const REJECTION_STATUS: Record<WebhookRejectionCode, number> = {
  SIGNATURE_MISSING: 401,
  SIGNATURE_MALFORMED: 401,
  SIGNATURE_MISMATCH: 401,
  EVENT_MISSING: 400,
  BODY_MALFORMED: 400,
};

async function handleWebhook(
  request: Request,
  deps: WebhookRouteDeps,
): Promise<Response> {
  if (request.method !== 'POST') {
    return refuse(405, 'METHOD_NOT_ALLOWED', 'a delivery is a POST');
  }
  if (deps.secret === null) {
    return refuse(
      503,
      'NOT_CONFIGURED',
      'this installation has no GitHub webhook secret configured',
    );
  }

  let delivery: WebhookDelivery;
  try {
    delivery = await handleWebhookDelivery(
      {
        event: request.headers.get(EVENT_HEADER),
        signature: request.headers.get(SIGNATURE_HEADER),
        body: new Uint8Array(await request.arrayBuffer()),
      },
      deps.secret,
    );
  } catch (cause) {
    if (cause instanceof WebhookRejected) {
      return refuse(REJECTION_STATUS[cause.code], cause.code, cause.message);
    }
    throw cause;
  }

  const { adapters, manifest } = await deps.current();
  const host = adapters.repository();
  // No repository integration configured: there is nothing this delivery
  // could name that this installation manages, so it is answered exactly as
  // an `ignored` delivery is — authenticated, and nothing to do.
  const passes =
    host === null
      ? []
      : await applyWebhookDelivery(
          { db: deps.db, clock: deps.clock, host },
          delivery,
        );
  if (passes.length > 0) {
    await dispatchAutoDeploys(
      { db: deps.db, clock: deps.clock, adapters, manifest },
      passes,
    );
  }

  // §21's module: authenticated deliveries answer 202 whether or not they were
  // about anything, so an attacker probing this endpoint cannot distinguish
  // "ignored" from "acted on" any more than GitHub's own retry logic needs to.
  return Response.json(
    { ok: true, value: { classified: delivery.kind } },
    { status: 202 },
  );
}
