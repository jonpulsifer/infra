import { Hono } from 'hono';
import type { AlertmanagerPayload } from './alertmanager.ts';
import { criticalFiringAlerts, resolvedFingerprints } from './alertmanager.ts';
import { bearerMatches } from './auth.ts';
import type { ResolvedConfig } from './config.ts';
import { FingerprintDedupe } from './dedupe.ts';
import { OutboundCallError, placeOutboundCall } from './elevenlabs.ts';
import { Limiter } from './limiter.ts';
import type { Log } from './log.ts';
import {
  DEFAULT_OBJECTIVE,
  defaultName,
  MissionStore,
  NAME_MAX_LEN,
  OBJECTIVE_MAX_LEN,
  parseKeyword,
  pollAndScore,
} from './mission.ts';
import { isQuietHours } from './quiet-hours.ts';
import { sanitizeReason } from './reason.ts';

/** Present only when missions are on: the agent's id and the allow-list. */
export interface MissionDeps {
  readonly agentId: string;
  /** Target key to E.164 number; the number never leaves this map. */
  readonly targets: ReadonlyMap<string, string>;
}

export interface ServerDeps {
  readonly config: ResolvedConfig;
  readonly log: Log;
  readonly mission?: MissionDeps;
  /** Overridable for tests; defaults to the wall clock. */
  readonly now?: () => number;
  /** Overridable for tests; defaults to a real wait between polls. */
  readonly sleep?: (ms: number) => Promise<void>;
}

interface CallRequest {
  readonly source: string;
  readonly dynamicVariables: Record<string, string>;
  readonly agentId?: string;
  readonly toNumber?: string;
  readonly conversationConfigOverride?: Record<string, unknown>;
  readonly logFields?: Record<string, unknown>;
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
  const missionLimiter = new Limiter({
    dailyCap: config.missionDailyCap,
    cooldownMs: config.cooldownMs,
  });
  const missions = new MissionStore();
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dedupe = new FingerprintDedupe();

  // The ring and alert routes dial the configured number. Only the mission
  // route passes one, and it comes from the allow-list, never a request.
  async function attemptCall(opts: CallRequest): Promise<CallOutcome> {
    try {
      const result = await placeOutboundCall({
        apiKey: config.elevenlabsApiKey,
        agentId: opts.agentId ?? config.agentId,
        agentPhoneNumberId: config.phoneNumberId,
        toNumber: opts.toNumber ?? config.toNumber,
        dynamicVariables: opts.dynamicVariables,
        conversationConfigOverride: opts.conversationConfigOverride,
      });
      log.info('call placed', {
        source: opts.source,
        ...opts.logFields,
        conversationId: result.conversationId,
      });
      return { ok: true, conversationId: result.conversationId };
    } catch (error) {
      const reason =
        error instanceof OutboundCallError ? error.reason : 'unknown';
      log.error('call failed', {
        source: opts.source,
        ...opts.logFields,
        reason,
      });
      return { ok: false, reason };
    }
  }

  /** Polls and scores in the background; never rejects. Null when unscored. */
  async function scoreMission(
    target: string,
    keyword: string,
    conversationId: string,
  ) {
    missions.set(conversationId, 'pending');
    try {
      const result = await pollAndScore({
        apiKey: config.elevenlabsApiKey,
        conversationId,
        keyword,
        sleep,
      });
      if (result) missions.set(conversationId, result);
      log.info('mission result', {
        target,
        conversationId,
        scored: result !== null,
        ...result,
      });
      return result;
    } catch {
      log.error('mission result', { target, conversationId, scored: false });
      return null;
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
    const outcome = await attemptCall({
      source: 'ring',
      dynamicVariables: { reason, source: 'ring' },
    });
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
      source: 'alertmanager',
      dynamicVariables: {
        reason: sanitizeReason(names),
        source: 'alertmanager',
      },
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

  // 503 before 401: with no token or no allow-list there is nothing to check
  // a bearer against.
  function missionGate(authorization: string | undefined) {
    const token = config.missionToken;
    if (!deps.mission || !token) return { status: 503 as const };
    if (!bearerMatches(authorization, token)) return { status: 401 as const };
    return { status: 200 as const, mission: deps.mission };
  }

  app.post('/mission', async (c) => {
    const gate = missionGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'missions off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid json' }, 400);
    }
    const keyword = parseKeyword(body.keyword);
    if (!keyword) return c.json({ error: 'invalid keyword' }, 400);
    const target = typeof body.target === 'string' ? body.target : '';
    const toNumber = gate.mission.targets.get(target);
    if (!toNumber) return c.json({ error: 'unknown target' }, 404);

    const name = sanitizeReason(body.name, NAME_MAX_LEN) || defaultName(target);
    const objective =
      sanitizeReason(body.objective, OBJECTIVE_MAX_LEN) || DEFAULT_OBJECTIVE;

    if (
      isQuietHours(
        new Date(now()),
        config.quietTz,
        config.quietStart,
        config.quietEnd,
      )
    ) {
      log.info('mission refused', { target, reason: 'quiet-hours' });
      return c.json({ ok: false, skipped: 'quiet-hours' }, 429);
    }
    const attempt = missionLimiter.attempt(now());
    if (!attempt.ok) {
      log.info('mission refused', { target, reason: attempt.reason });
      return c.json({ ok: false, skipped: attempt.reason }, 429);
    }

    const outcome = await attemptCall({
      source: 'mission',
      agentId: gate.mission.agentId,
      toNumber,
      dynamicVariables: {
        target_name: name,
        keyword,
        objective,
      },
      conversationConfigOverride: { asr: { keywords: [keyword] } },
      logFields: { target },
    });
    if (!outcome.ok) return c.json({ ok: false, error: 'call failed' }, 502);

    const scoring = scoreMission(target, keyword, outcome.conversationId);
    if (body.wait !== true) {
      return c.json({ ok: true, conversationId: outcome.conversationId }, 202);
    }
    const result = await scoring;
    return result
      ? c.json({ ok: true, conversationId: outcome.conversationId, result })
      : c.json({
          ok: true,
          conversationId: outcome.conversationId,
          status: 'pending',
        });
  });

  app.get('/mission/:conversationId', (c) => {
    const gate = missionGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'missions off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const stored = missions.get(c.req.param('conversationId'));
    if (stored === undefined) return c.json({ error: 'unknown mission' }, 404);
    return stored === 'pending'
      ? c.json({ status: 'pending' })
      : c.json({ status: 'done', result: stored });
  });

  return app;
}
