import { Hono } from 'hono';
import type { AlertmanagerPayload } from './alertmanager.ts';
import { criticalFiringAlerts, resolvedFingerprints } from './alertmanager.ts';
import { bearerMatches } from './auth.ts';
import type { ResolvedConfig } from './config.ts';
import { FingerprintDedupe } from './dedupe.ts';
import { OutboundCallError, placeOutboundCall } from './elevenlabs.ts';
import { Limiter } from './limiter.ts';
import type { Log } from './log.ts';
import { isQuietHours } from './quiet-hours.ts';
import { sanitizeReason } from './reason.ts';

export interface ServerDeps {
  readonly config: ResolvedConfig;
  readonly log: Log;
  /** Overridable for tests; defaults to the wall clock. */
  readonly now?: () => number;
}

type CallOutcome =
  | { readonly ok: true; readonly conversationId: string }
  | { readonly ok: false; readonly reason: string };

export function createApp(deps: ServerDeps) {
  const { config, log } = deps;
  const now = deps.now ?? (() => Date.now());
  const ringLimiter = new Limiter({
    dailyCap: config.ringDailyCap,
    cooldownMs: config.cooldownMs,
  });
  const alertLimiter = new Limiter({
    dailyCap: config.alertDailyCap,
    cooldownMs: config.cooldownMs,
  });
  const dedupe = new FingerprintDedupe();

  // The destination number always comes from config; no argument here takes one.
  async function attemptCall(opts: {
    readonly reason: string;
    readonly source: string;
  }): Promise<CallOutcome> {
    try {
      const result = await placeOutboundCall({
        apiKey: config.elevenlabsApiKey,
        agentId: config.agentId,
        agentPhoneNumberId: config.phoneNumberId,
        toNumber: config.toNumber,
        reason: opts.reason,
        source: opts.source,
      });
      log.info('call placed', {
        source: opts.source,
        conversationId: result.conversationId,
      });
      return { ok: true, conversationId: result.conversationId };
    } catch (error) {
      const reason =
        error instanceof OutboundCallError ? error.reason : 'unknown';
      log.error('call failed', { source: opts.source, reason });
      return { ok: false, reason };
    }
  }

  const app = new Hono();

  app.get('/healthz', (c) => c.text('ok'));

  app.post('/ring', async (c) => {
    if (!bearerMatches(c.req.header('authorization'), config.ringToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const attempt = ringLimiter.attempt(now());
    if (!attempt.ok) {
      log.info('ring refused', { reason: attempt.reason });
      return c.json({ ok: false, skipped: attempt.reason }, 429);
    }
    let reason = '';
    try {
      const body = (await c.req.json()) as { reason?: unknown };
      reason = sanitizeReason(body?.reason);
    } catch {
      // No body, or not JSON: ring with no reason.
    }
    const outcome = await attemptCall({ reason, source: 'ring' });
    return outcome.ok
      ? c.json({ ok: true, conversationId: outcome.conversationId })
      : c.json({ ok: false, error: 'call failed' }, 502);
  });

  app.post('/alertmanager', async (c) => {
    if (!bearerMatches(c.req.header('authorization'), config.alertToken)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    let payload: AlertmanagerPayload;
    try {
      payload = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    // A resolved alert always clears its fingerprint, even when this batch
    // carries no new critical alert, so a later re-fire can page again.
    for (const fingerprint of resolvedFingerprints(payload)) {
      dedupe.clear(fingerprint);
    }

    const eligible = criticalFiringAlerts(payload).filter((a) =>
      dedupe.isNew(a.fingerprint),
    );
    if (eligible.length === 0) {
      return c.json({ ok: true, action: 'skipped-no-new-critical' });
    }

    if (
      isQuietHours(
        new Date(now()),
        config.quietTz,
        config.quietStart,
        config.quietEnd,
      )
    ) {
      log.info('alert call skipped', { reason: 'quiet-hours' });
      return c.json({ ok: true, action: 'skipped-quiet-hours' });
    }

    const attempt = alertLimiter.attempt(now());
    if (!attempt.ok) {
      log.info('alert call refused', { reason: attempt.reason });
      return c.json({ ok: true, action: `skipped-${attempt.reason}` });
    }

    const names = [
      ...new Set(eligible.map((a) => a.labels?.alertname).filter(Boolean)),
    ].join(', ');
    const outcome = await attemptCall({
      reason: sanitizeReason(names),
      source: 'alertmanager',
    });
    if (!outcome.ok) {
      return c.json({ ok: false, action: 'call-failed' }, 502);
    }
    // Only a placed call is remembered: a failed attempt (an ElevenLabs
    // outage, say) can still page on the alert's next repeat notification.
    for (const alert of eligible) dedupe.markSeen(alert.fingerprint);
    return c.json({
      ok: true,
      action: 'called',
      conversationId: outcome.conversationId,
    });
  });

  return app;
}
