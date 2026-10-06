/**
 * The GitHub repository webhook route. The signature is its only
 * authentication: a delivery carries no session.
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

export interface WebhookRouteDeps {
  readonly db: Database;
  readonly clock: Clock;
  /**
   * The sealed App webhook secret, read per delivery because setup writes it
   * while the process runs; `null` refuses them all.
   */
  secret(): Promise<string | null>;
  /**
   * Read per request, because `configureInstallation` rewrites it while the
   * process runs.
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
  const secret = await deps.secret();
  if (secret === null) {
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
      secret,
    );
  } catch (cause) {
    if (cause instanceof WebhookRejected) {
      return refuse(REJECTION_STATUS[cause.code], cause.code, cause.message);
    }
    throw cause;
  }

  const { adapters, manifest } = await deps.current();
  const host = adapters.repository();
  // With no repository integration, nothing a delivery names is managed here.
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

  // Every authenticated delivery answers 202, acted on or ignored.
  return Response.json(
    { ok: true, value: { classified: delivery.kind } },
    { status: 202 },
  );
}
