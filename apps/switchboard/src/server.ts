import { Hono } from 'hono';
import type { AlertmanagerPayload } from './alertmanager.ts';
import { criticalFiringAlerts, resolvedFingerprints } from './alertmanager.ts';
import { bearerMatches } from './auth.ts';
import type { ResolvedConfig } from './config.ts';
import { FingerprintDedupe } from './dedupe.ts';
import {
  fetchAgent,
  OutboundCallError,
  patchAgent,
  placeOutboundCall,
  simulateConversation,
} from './elevenlabs.ts';
import type { GithubApp } from './github.ts';
import { Limiter } from './limiter.ts';
import type { Log } from './log.ts';
import {
  CALLEE_FIRST_MESSAGE,
  CALLEE_MAX_LEN,
  DEFAULT_OBJECTIVE,
  defaultCallee,
  defaultName,
  MissionStore,
  NAME_MAX_LEN,
  OBJECTIVE_MAX_LEN,
  parseKeyword,
  pollAndScore,
  REHEARSAL_TURNS,
  REHEARSAL_TURNS_MAX,
  SCENARIO_MAX_LEN,
  scoreConversation,
} from './mission.ts';
import {
  applyPersona,
  MESSAGE_MAX_LEN,
  type Persona,
  pickPersona,
  renderAgentFile,
  tagsUsed,
  toAgentPatch,
  validatePersona,
} from './persona.ts';
import { isQuietHours } from './quiet-hours.ts';
import { sanitizeReason } from './reason.ts';

/** Present only when missions are on: the agent's id and the allow-list. */
export interface MissionDeps {
  readonly agentId: string;
  /** Target key to E.164 number; the number never leaves this map. */
  readonly targets: ReadonlyMap<string, string>;
}

/** Present only when the persona routes are on. */
export interface PersonaDeps {
  /** Agent name to id, for every agent the routes may edit. */
  readonly agents: ReadonlyMap<string, string>;
  /** Absent: an edit is live only and the snapshot is skipped. */
  readonly github?: Pick<GithubApp, 'readFile' | 'openSnapshot'>;
  /** The repo directory of the desired agent files. */
  readonly dir: string;
  /** The branch a snapshot targets. */
  readonly base: string;
}

export type SnapshotOutcome =
  | {
      readonly status: 'opened';
      readonly url: string;
      readonly autoMerge: boolean;
    }
  | { readonly status: 'unchanged' }
  | { readonly status: 'skipped'; readonly reason: string }
  | { readonly status: 'failed'; readonly reason: string };

export interface ServerDeps {
  readonly config: ResolvedConfig;
  readonly log: Log;
  readonly mission?: MissionDeps;
  readonly persona?: PersonaDeps;
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
      // The callee's own words stay in the stored result and the HTTP
      // answers, never the pod log.
      const {
        winningLine: _words,
        transcript: _transcript,
        ...loggable
      } = result ?? {};
      log.info('mission result', {
        target,
        conversationId,
        scored: result !== null,
        ...loggable,
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
    // Sent only when given: an empty variable would blank the agent's own
    // placeholder, which tells it to invent a cover story.
    const scenario = sanitizeReason(body.scenario, SCENARIO_MAX_LEN);

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
        ...(scenario && { scenario }),
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

  // A rehearsal plays the agent against a simulated callee in text and scores
  // the transcript the same way. Nothing is dialled, so neither the limiter
  // nor quiet hours apply, and a target is optional: it only names the callee.
  app.post('/mission/rehearse', async (c) => {
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
    if (target && !gate.mission.targets.has(target)) {
      return c.json({ error: 'unknown target' }, 404);
    }
    const name =
      sanitizeReason(body.name, NAME_MAX_LEN) ||
      (target ? defaultName(target) : 'there');
    const objective =
      sanitizeReason(body.objective, OBJECTIVE_MAX_LEN) || DEFAULT_OBJECTIVE;
    const scenario = sanitizeReason(body.scenario, SCENARIO_MAX_LEN);
    const callee =
      sanitizeReason(body.callee, CALLEE_MAX_LEN) || defaultCallee(name);
    const turns =
      typeof body.turns === 'number' && Number.isInteger(body.turns)
        ? Math.min(Math.max(body.turns, 2), REHEARSAL_TURNS_MAX)
        : REHEARSAL_TURNS;

    const conversation = await simulateConversation({
      apiKey: config.elevenlabsApiKey,
      agentId: gate.mission.agentId,
      dynamicVariables: {
        target_name: name,
        keyword,
        objective,
        ...(scenario && { scenario }),
      },
      calleePrompt: callee,
      calleeFirstMessage: CALLEE_FIRST_MESSAGE,
      turns,
    });
    if (!conversation) {
      log.error('rehearsal failed', { target });
      return c.json({ ok: false, error: 'rehearsal failed' }, 502);
    }
    const result = scoreConversation(conversation, keyword);
    log.info('rehearsal result', {
      target,
      won: result.won,
      turn: result.turn,
      agentSaidFirst: result.agentSaidFirst,
      turns: result.transcript.length,
    });
    return c.json({ ok: true, rehearsal: true, result });
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

  // The persona routes: the character of each agent, read and written live,
  // with every write snapshotted into git as a pull request. 503 before 401,
  // as for missions.
  function personaGate(authorization: string | undefined) {
    const token = config.personaToken;
    if (!deps.persona || !token) return { status: 503 as const };
    if (!bearerMatches(authorization, token)) return { status: 401 as const };
    return { status: 200 as const, persona: deps.persona };
  }

  // One snapshot at a time per agent: two edits close together would
  // otherwise race for the same base and open two pull requests.
  const snapshotQueue = new Map<string, Promise<unknown>>();
  function queued<T>(name: string, work: () => Promise<T>): Promise<T> {
    const previous = snapshotQueue.get(name) ?? Promise.resolve();
    const next = previous.then(work, work);
    snapshotQueue.set(
      name,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Writes the live persona into the agent's file in git on a fresh branch
   * and opens the pull request. Never throws: the live edit stands whatever
   * GitHub says, and the outcome is in the answer and the log.
   */
  async function snapshot(
    persona: PersonaDeps,
    name: string,
    live: Persona,
  ): Promise<SnapshotOutcome> {
    const { github } = persona;
    if (!github) {
      return { status: 'skipped', reason: 'no github app' };
    }
    const path = `${persona.dir}/${name}.json`;
    try {
      const current = await github.readFile(path, persona.base);
      let file: unknown;
      try {
        file = JSON.parse(current.content);
      } catch {
        return { status: 'failed', reason: `${path} is not JSON` };
      }
      const next = renderAgentFile(applyPersona(file, live));
      if (
        JSON.stringify(pickPersona(file)) === JSON.stringify(live) ||
        next === current.content
      ) {
        return { status: 'unchanged' };
      }
      const stamp = new Date(now())
        .toISOString()
        .replace(/[-:.TZ]/g, '')
        .slice(0, 14);
      const changed = Object.keys(live).join(', ');
      const opened = await github.openSnapshot({
        path,
        content: next,
        base: persona.base,
        branch: `persona/${name}-${stamp}`,
        title: `chore(elevenlabs): snapshot the ${name} persona`,
        body:
          `The live persona of \`${name}\` changed, and this writes it into its file so git holds what is live. ` +
          `Leaves in the snapshot: ${changed}.\n\nThe reconciler never patches these leaves, so merging changes nothing live.`,
      });
      log.info('persona snapshot opened', {
        name,
        number: opened.number,
        autoMerge: opened.autoMerge,
      });
      return { status: 'opened', url: opened.url, autoMerge: opened.autoMerge };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unknown';
      log.error('persona snapshot failed', { name, reason });
      return { status: 'failed', reason };
    }
  }

  app.get('/persona', (c) => {
    const gate = personaGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'personas off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const agents = [...gate.persona.agents].map(([name, agentId]) => ({
      name,
      agentId,
    }));
    return c.json({ agents, snapshot: Boolean(gate.persona.github) });
  });

  app.get('/persona/:name', async (c) => {
    const gate = personaGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'personas off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    const agentId = gate.persona.agents.get(name);
    if (!agentId) return c.json({ error: 'unknown agent' }, 404);
    const agent = await fetchAgent(config.elevenlabsApiKey, agentId);
    if (!agent) return c.json({ error: 'agent not read' }, 502);
    return c.json({ name, persona: pickPersona(agent) });
  });

  app.patch('/persona/:name', async (c) => {
    const gate = personaGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'personas off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    const agentId = gate.persona.agents.get(name);
    if (!agentId) return c.json({ error: 'unknown agent' }, 404);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    const checked = validatePersona(body);
    if (!checked.ok) return c.json({ error: checked.error }, 400);

    const outcome = await queued(name, async () => {
      const patched = await patchAgent(
        config.elevenlabsApiKey,
        agentId,
        toAgentPatch(checked.persona),
      );
      if (!patched) return { status: 502 as const };
      const agent = await fetchAgent(config.elevenlabsApiKey, agentId);
      if (!agent) return { status: 502 as const, patched: true };
      const live = pickPersona(agent);
      // The leaf names, never the text: the prompt is long and is the
      // owner's, and the log is for the shape of what happened.
      log.info('persona patched', {
        name,
        leaves: leafNames(checked.persona),
      });
      return {
        status: 200 as const,
        live,
        snapshot: await snapshot(gate.persona, name, live),
      };
    });
    if (outcome.status !== 200) {
      log.error('persona patch failed', { name, patched: outcome.patched });
      return c.json({ error: 'agent not patched' }, 502);
    }
    return c.json({
      ok: true,
      name,
      persona: outcome.live,
      snapshot: outcome.snapshot,
    });
  });

  // For an edit made in the ElevenLabs dashboard: the live persona goes into
  // git the same way, with nothing written to the agent.
  app.post('/persona/:name/snapshot', async (c) => {
    const gate = personaGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'personas off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    const agentId = gate.persona.agents.get(name);
    if (!agentId) return c.json({ error: 'unknown agent' }, 404);
    const outcome = await queued(name, async () => {
      const agent = await fetchAgent(config.elevenlabsApiKey, agentId);
      if (!agent) return null;
      const live = pickPersona(agent);
      return { live, snapshot: await snapshot(gate.persona, name, live) };
    });
    if (!outcome) return c.json({ error: 'agent not read' }, 502);
    return c.json({
      ok: true,
      name,
      persona: outcome.live,
      snapshot: outcome.snapshot,
    });
  });

  // A rehearsal of any agent against a simulated caller, in text: the
  // transcript and the audio tags the agent wrote, so a persona edit can be
  // judged without a call.
  app.post('/persona/:name/rehearse', async (c) => {
    const gate = personaGate(c.req.header('authorization'));
    if (gate.status === 503) return c.json({ error: 'personas off' }, 503);
    if (gate.status === 401) return c.json({ error: 'unauthorized' }, 401);
    const name = c.req.param('name');
    const agentId = gate.persona.agents.get(name);
    if (!agentId) return c.json({ error: 'unknown agent' }, 404);
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'invalid json' }, 400);
    }
    const caller = sanitizeReason(body.caller, CALLEE_MAX_LEN);
    if (!caller) return c.json({ error: 'caller is required' }, 400);
    const firstMessage =
      sanitizeReason(body.first_message, MESSAGE_MAX_LEN) ||
      CALLEE_FIRST_MESSAGE;
    const turns =
      typeof body.turns === 'number' && Number.isInteger(body.turns)
        ? Math.min(Math.max(body.turns, 2), REHEARSAL_TURNS_MAX)
        : REHEARSAL_TURNS;
    const variables = dynamicVariables(body.dynamic_variables);
    if (variables instanceof Error) {
      return c.json({ error: variables.message }, 400);
    }

    const conversation = await simulateConversation({
      apiKey: config.elevenlabsApiKey,
      agentId,
      dynamicVariables: variables,
      calleePrompt: caller,
      calleeFirstMessage: firstMessage,
      turns,
    });
    if (!conversation) {
      log.error('persona rehearsal failed', { name });
      return c.json({ ok: false, error: 'rehearsal failed' }, 502);
    }
    const transcript = (conversation.transcript ?? []).flatMap((entry) =>
      entry.message && (entry.role === 'user' || entry.role === 'agent')
        ? [{ role: entry.role, message: entry.message.trim() }]
        : [],
    );
    const tags = tagsUsed(conversation.transcript ?? []);
    log.info('persona rehearsal', {
      name,
      turns: transcript.length,
      tags: tags.length,
    });
    return c.json({ ok: true, name, transcript, tags });
  });

  return app;
}

function leafNames(persona: Persona): string[] {
  const names: string[] = [];
  for (const [key, value] of Object.entries(persona)) {
    if (key === 'tts' && value && typeof value === 'object') {
      for (const leaf of Object.keys(value)) names.push(`tts.${leaf}`);
    } else {
      names.push(key);
    }
  }
  return names;
}

const VARIABLES_MAX = 12;
const VARIABLE_NAME = /^[a-z][a-z0-9_]{0,40}$/;
const VARIABLE_MAX_LEN = 1_500;

/** The dynamic variables a rehearsal sets: a flat map of short strings. */
function dynamicVariables(raw: unknown): Record<string, string> | Error {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return new Error('dynamic_variables must be an object');
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > VARIABLES_MAX) {
    return new Error(`dynamic_variables holds at most ${VARIABLES_MAX}`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!VARIABLE_NAME.test(key)) {
      return new Error(`dynamic_variables has a bad name: ${key.slice(0, 40)}`);
    }
    if (typeof value !== 'string' || value.length > VARIABLE_MAX_LEN) {
      return new Error(`dynamic_variables.${key} must be a short string`);
    }
    out[key] = value;
  }
  return out;
}
