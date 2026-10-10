import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedConfig } from '../src/config.ts';
import type { Fields, Log } from '../src/log.ts';
import {
  DEFAULT_OBJECTIVE,
  REHEARSAL_TURNS,
  REHEARSAL_TURNS_MAX,
} from '../src/mission.ts';
import { createApp } from '../src/server.ts';

const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
});

const baseConfig: ResolvedConfig = {
  elevenlabsApiKey: 'super-secret-key',
  agentName: 'pbx-switchboard',
  agentId: 'agent_1',
  phoneNumberId: 'phnum_1',
  toNumber: '+19025551234',
  ringToken: 'ring-secret',
  alertToken: 'alert-secret',
  ringDailyCap: 2,
  alertDailyCap: 2,
  cooldownMs: 10 * 60_000,
  missionToken: 'mission-secret',
  missionAgentName: 'pbx-mission',
  targetsDir: '/targets',
  missionDailyCap: 2,
  quietStart: '23:00',
  quietEnd: '08:00',
  quietTz: 'UTC',
  port: 8080,
  personaToken: 'persona-secret',
  personaAgentNames: ['pbx-troll', 'pbx-mission'],
  personaDir: 'clusters/offsite/apps/elevenlabs/desired/agents',
  githubOwner: 'jonpulsifer',
  githubRepo: 'infra',
  githubBase: 'main',
};

function fakeLog(): { log: Log; lines: string[] } {
  const lines: string[] = [];
  const capture = (msg: string, fields?: Fields) =>
    lines.push(JSON.stringify({ msg, ...fields }));
  return { log: { info: capture, warn: capture, error: capture }, lines };
}

function mockElevenLabs(handler: () => Response) {
  const calls: { url: string; body: string }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init.body) });
    return handler();
  }) as unknown as typeof fetch;
  return calls;
}

const ok = () => Response.json({ success: true, conversation_id: 'conv_1' });
const failing = () => new Response('bad gateway', { status: 502 });

function clock(startMs: number) {
  let now = startMs;
  return { fn: () => now, set: (ms: number) => (now = ms) };
}

// Outside quiet hours (23:00-08:00 UTC in baseConfig), so tests that do not
// exercise quiet hours themselves are not at the mercy of the wall clock.
const DAYTIME = new Date('2026-01-01T12:00:00Z').getTime();

describe('GET /healthz', () => {
  test('answers ok with no auth', async () => {
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });
});

describe('auth', () => {
  test('refuses /ring and /alertmanager without the right bearer token', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });

    const attempts: [string, unknown][] = [
      ['/ring', {}],
      ['/alertmanager', { alerts: [] }],
    ];
    for (const [path, body] of attempts) {
      const noAuth = await app.request(path, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      expect(noAuth.status).toBe(401);
      const wrongAuth = await app.request(path, {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
        body: JSON.stringify(body),
      });
      expect(wrongAuth.status).toBe(401);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('POST /ring', () => {
  const ring = (app: ReturnType<typeof createApp>, body?: unknown) =>
    app.request('/ring', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ring-secret',
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  test('places a call and answers the conversation id', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const res = await ring(app, { reason: 'testing switchboard' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, conversationId: 'conv_1' });
    expect(calls).toHaveLength(1);
  });

  test('the destination number comes only from the environment, never the request', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    await ring(app, {
      reason: 'hi',
      to_number: '+19999999999',
      to: '+18885551234',
      number: '+17775551234',
    });
    const sent = JSON.parse(calls[0]?.body ?? '{}');
    expect(sent.to_number).toBe('19025551234');
  });

  test('a request with no body still rings, with an empty reason', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const res = await app.request('/ring', {
      method: 'POST',
      headers: { authorization: 'Bearer ring-secret' },
    });
    expect(res.status).toBe(200);
    const sent = JSON.parse(calls[0]?.body ?? '{}');
    expect(
      sent.conversation_initiation_client_data.dynamic_variables.reason,
    ).toBe('');
  });

  test('a reason is sanitized before it reaches ElevenLabs', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const raw = `call\x00now\n${'x'.repeat(500)}`;
    await ring(app, { reason: raw });
    const sent = JSON.parse(calls[0]?.body ?? '{}');
    const expected = 'callnow'.concat('x'.repeat(500)).slice(0, 200);
    expect(
      sent.conversation_initiation_client_data.dynamic_variables.reason,
    ).toBe(expected);
  });

  test('the daily cap counts every attempt, including failed ones', async () => {
    mockElevenLabs(failing);
    const { log } = fakeLog();
    const app = createApp({
      config: { ...baseConfig, ringDailyCap: 2, cooldownMs: 0 },
      log,
    });
    expect((await ring(app)).status).toBe(502);
    expect((await ring(app)).status).toBe(502);
    const capped = await ring(app);
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ ok: false, skipped: 'daily-cap' });
  });

  test('a failed call is never retried', async () => {
    const calls = mockElevenLabs(failing);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    await ring(app);
    expect(calls).toHaveLength(1);
  });

  test('a cooldown blocks a second ring, then clears', async () => {
    mockElevenLabs(ok);
    const { log } = fakeLog();
    const c = clock(0);
    const app = createApp({
      config: { ...baseConfig, cooldownMs: 5 * 60_000 },
      log,
      now: c.fn,
    });
    expect((await ring(app)).status).toBe(200);
    c.set(4 * 60_000);
    const early = await ring(app);
    expect(early.status).toBe(429);
    expect(await early.json()).toEqual({ ok: false, skipped: 'cooldown' });
    c.set(5 * 60_000);
    expect((await ring(app)).status).toBe(200);
  });

  test('nothing logged names the destination number, a URL, a body, or a token', async () => {
    mockElevenLabs(ok);
    const { log, lines } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    await ring(app, { reason: 'call the owner now' });
    const dump = lines.join('\n');
    expect(dump).not.toContain(baseConfig.toNumber);
    expect(dump).not.toContain(baseConfig.ringToken);
    expect(dump).not.toContain(baseConfig.elevenlabsApiKey);
    expect(dump).not.toContain('https://api.elevenlabs.io');
  });
});

describe('POST /alertmanager', () => {
  const send = (app: ReturnType<typeof createApp>, payload: unknown) =>
    app.request('/alertmanager', {
      method: 'POST',
      headers: {
        authorization: 'Bearer alert-secret',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

  const critical = (fingerprint: string, alertname = 'PBXDown') => ({
    status: 'firing',
    labels: { severity: 'critical', alertname },
    fingerprint,
  });

  test('a critical firing alert places one call', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log, now: () => DAYTIME });
    const res = await send(app, { alerts: [critical('fp1')] });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, action: 'called' });
    expect(calls).toHaveLength(1);
  });

  test('a warning alert and the Watchdog alert never call', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const res = await send(app, {
      alerts: [
        {
          status: 'firing',
          labels: { severity: 'warning', alertname: 'SlowDisk' },
          fingerprint: 'fp1',
        },
        {
          status: 'firing',
          labels: { severity: 'critical', alertname: 'Watchdog' },
          fingerprint: 'fp2',
        },
      ],
    });
    expect(await res.json()).toMatchObject({
      action: 'skipped-no-new-critical',
    });
    expect(calls).toHaveLength(0);
  });

  test('dedupes by fingerprint: a repeated notification calls only once', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log, now: () => DAYTIME });
    await send(app, { alerts: [critical('fp1')] });
    const second = await send(app, { alerts: [critical('fp1')] });
    expect(await second.json()).toMatchObject({
      action: 'skipped-no-new-critical',
    });
    expect(calls).toHaveLength(1);
  });

  test('a resolved alert clears the dedupe, so a re-fire can page again', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const app = createApp({
      config: { ...baseConfig, cooldownMs: 0 },
      log,
      now: () => DAYTIME,
    });
    await send(app, { alerts: [critical('fp1')] });
    await send(app, {
      alerts: [
        {
          status: 'resolved',
          labels: { severity: 'critical', alertname: 'PBXDown' },
          fingerprint: 'fp1',
        },
      ],
    });
    const third = await send(app, { alerts: [critical('fp1')] });
    expect(await third.json()).toMatchObject({ action: 'called' });
    expect(calls).toHaveLength(2);
  });

  test('a failed call is not deduped, so the next notification can retry', async () => {
    const calls = mockElevenLabs(failing);
    const { log } = fakeLog();
    const app = createApp({
      config: { ...baseConfig, cooldownMs: 0 },
      log,
      now: () => DAYTIME,
    });
    const first = await send(app, { alerts: [critical('fp1')] });
    expect(await first.json()).toMatchObject({ action: 'call-failed' });
    const second = await send(app, { alerts: [critical('fp1')] });
    expect(await second.json()).toMatchObject({ action: 'call-failed' });
    expect(calls).toHaveLength(2);
  });

  test('quiet hours skip the call and do not spend the cap', async () => {
    const calls = mockElevenLabs(ok);
    const { log } = fakeLog();
    const c = clock(new Date('2026-01-01T02:00:00Z').getTime());
    const app = createApp({ config: baseConfig, log, now: c.fn });
    const res = await send(app, { alerts: [critical('fp1')] });
    expect(await res.json()).toEqual({
      ok: true,
      action: 'skipped-quiet-hours',
    });
    expect(calls).toHaveLength(0);
    // Outside quiet hours, the same still-firing alert can still page.
    c.set(new Date('2026-01-01T12:00:00Z').getTime());
    const awake = await send(app, { alerts: [critical('fp1')] });
    expect(await awake.json()).toMatchObject({ action: 'called' });
    expect(calls).toHaveLength(1);
  });

  test('the daily cap applies to alert calls, independent of fingerprint', async () => {
    mockElevenLabs(ok);
    const { log } = fakeLog();
    const c = clock(new Date('2026-01-01T12:00:00Z').getTime());
    const app = createApp({
      config: { ...baseConfig, alertDailyCap: 1, cooldownMs: 0 },
      log,
      now: c.fn,
    });
    await send(app, { alerts: [critical('fp1')] });
    const capped = await send(app, { alerts: [critical('fp2')] });
    expect(await capped.json()).toMatchObject({ action: 'skipped-daily-cap' });
  });

  test('the cooldown applies to alert calls, independent of fingerprint', async () => {
    mockElevenLabs(ok);
    const { log } = fakeLog();
    const c = clock(new Date('2026-01-01T12:00:00Z').getTime());
    const app = createApp({
      config: { ...baseConfig, alertDailyCap: 5, cooldownMs: 5 * 60_000 },
      log,
      now: c.fn,
    });
    await send(app, { alerts: [critical('fp1')] });
    const early = await send(app, { alerts: [critical('fp2')] });
    expect(await early.json()).toMatchObject({ action: 'skipped-cooldown' });
  });

  test('an invalid JSON body is refused, not a crash', async () => {
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log });
    const res = await app.request('/alertmanager', {
      method: 'POST',
      headers: { authorization: 'Bearer alert-secret' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
  });
});

describe('/mission', () => {
  const targets = new Map([['sam', '+15555550123']]);
  const mission = { agentId: 'agent_mission', targets };
  const auth = { authorization: 'Bearer mission-secret' };

  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/mission', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // Answers the outbound call, then the conversation polls with `statuses`.
  function mockMission(...statuses: string[]) {
    const sent: { url: string; body: string }[] = [];
    let polls = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: String(init.body) });
      if (String(url).includes('/conversations/')) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return Response.json({
          status,
          transcript: [
            { role: 'agent', message: 'Hello', time_in_call_secs: 1 },
            { role: 'user', message: 'I love otters', time_in_call_secs: 7 },
          ],
          metadata: { call_duration_secs: 30 },
        });
      }
      return ok();
    }) as unknown as typeof fetch;
    return sent;
  }

  function appWith(overrides: Partial<Parameters<typeof createApp>[0]> = {}) {
    const { log, lines } = fakeLog();
    const c = clock(DAYTIME);
    const app = createApp({
      config: baseConfig,
      log,
      mission,
      now: c.fn,
      sleep: async () => {},
      ...overrides,
    });
    return { app, lines, clock: c };
  }

  test('503 when the token or the allow-list is absent', async () => {
    const noMission = appWith({ mission: undefined }).app;
    const noToken = appWith({
      config: { ...baseConfig, missionToken: undefined },
    }).app;
    for (const app of [noMission, noToken]) {
      const res = await post(app, { target: 'sam', keyword: 'otter' });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'missions off' });
    }
  });

  test('401 on a bad token, 400 on a bad keyword, 404 on an unknown target', async () => {
    const calls = mockMission('done');
    const { app } = appWith();
    const bad = await app.request('/mission', {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
      body: '{}',
    });
    expect(bad.status).toBe(401);
    expect((await post(app, { target: 'sam', keyword: 'ot7er' })).status).toBe(
      400,
    );
    expect((await post(app, { target: 'sam' })).status).toBe(400);
    const unknown = await post(app, { target: 'nobody', keyword: 'otter' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: 'unknown target' });
    expect(calls).toHaveLength(0);
  });

  test('429 in quiet hours, spending nothing', async () => {
    const calls = mockMission('done');
    const { app, clock: c } = appWith();
    c.set(new Date('2026-01-01T03:00:00Z').getTime());
    const res = await post(app, { target: 'sam', keyword: 'otter' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, skipped: 'quiet-hours' });
    expect(calls).toHaveLength(0);
  });

  test('429 on the cooldown and then the daily cap', async () => {
    mockMission('in-progress');
    const { app, clock: c } = appWith();
    const go = () => post(app, { target: 'sam', keyword: 'otter' });
    expect((await go()).status).toBe(202);
    const cooling = await go();
    expect(cooling.status).toBe(429);
    expect(await cooling.json()).toEqual({ ok: false, skipped: 'cooldown' });
    c.set(DAYTIME + 11 * 60_000);
    expect((await go()).status).toBe(202);
    c.set(DAYTIME + 22 * 60_000);
    const capped = await go();
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ ok: false, skipped: 'daily-cap' });
  });

  test('202 without wait; the call carries the variables and the override', async () => {
    const sent = mockMission('done');
    const { app } = appWith();
    const res = await post(app, { target: 'sam', keyword: 'otter' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ ok: true, conversationId: 'conv_1' });
    const body = JSON.parse(sent[0]?.body ?? '{}');
    expect(body.agent_id).toBe('agent_mission');
    expect(body.to_number).toBe('15555550123');
    expect(body.conversation_initiation_client_data).toEqual({
      dynamic_variables: {
        target_name: 'Sam',
        keyword: 'otter',
        objective:
          'Get them to say the keyword out loud, without ever saying it yourself.',
      },
      conversation_config_override: { asr: { keywords: ['otter'] } },
    });
  });

  test('name and objective come from the request, sanitized', async () => {
    const sent = mockMission('done');
    const { app } = appWith();
    await post(app, {
      target: 'sam',
      keyword: 'otter',
      name: 'Sammy\n',
      objective: 'be \x00nice',
    });
    const vars = JSON.parse(sent[0]?.body ?? '{}')
      .conversation_initiation_client_data.dynamic_variables;
    expect(vars).toMatchObject({ target_name: 'Sammy', objective: 'be nice' });
    // No scenario given: the variable is absent, so the agent's own
    // placeholder tells it to invent a cover story.
    expect(vars).not.toHaveProperty('scenario');
  });

  test('a scenario is passed through, sanitized, when given', async () => {
    const sent = mockMission('done');
    const { app } = appWith();
    await post(app, {
      target: 'sam',
      keyword: 'otter',
      scenario: 'You are at the zoo.\x07 Ask what the river one is.',
    });
    const vars = JSON.parse(sent[0]?.body ?? '{}')
      .conversation_initiation_client_data.dynamic_variables;
    expect(vars.scenario).toBe(
      'You are at the zoo. Ask what the river one is.',
    );
  });

  test('wait answers 200 with the scored result', async () => {
    mockMission('in-progress', 'done');
    const { app } = appWith();
    const res = await post(app, {
      target: 'sam',
      keyword: 'otter',
      wait: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      conversationId: 'conv_1',
      result: { won: true, turn: 1, secondsToWin: 7, durationSecs: 30 },
    });
  });

  test('wait answers pending when the poll limit runs out', async () => {
    mockMission('in-progress');
    const { app } = appWith();
    const res = await post(app, {
      target: 'sam',
      keyword: 'otter',
      wait: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      conversationId: 'conv_1',
      status: 'pending',
    });
  });

  test('GET answers pending, then done, and 404 for an unknown id', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { app } = appWith();
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/conversations/')) {
        await gate;
        return Response.json({ status: 'done', transcript: [] });
      }
      return ok();
    }) as unknown as typeof fetch;
    await post(app, { target: 'sam', keyword: 'otter' });
    const get = (id: string, headers: Record<string, string> = auth) =>
      app.request(`/mission/${id}`, { headers });
    expect(await (await get('conv_1')).json()).toEqual({ status: 'pending' });
    release();
    await Bun.sleep(10);
    expect(await (await get('conv_1')).json()).toMatchObject({
      status: 'done',
      result: { won: false },
    });
    expect((await get('conv_nope')).status).toBe(404);
    expect((await get('conv_1', {})).status).toBe(401);
  });

  test('logs one mission result line with the target and never the number or transcript', async () => {
    mockMission('done');
    const { app, lines } = appWith();
    await post(app, { target: 'sam', keyword: 'otter', wait: true });
    const results = lines.filter((l) => l.includes('"mission result"'));
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('"target":"sam"');
    const all = lines.join('\n');
    expect(all).not.toContain('5555550123');
    expect(all).not.toContain('I love otters');
  });

  test('the log never carries the winning line, though the answer does', async () => {
    globalThis.fetch = (async (url: string) =>
      String(url).includes('/conversations/')
        ? Response.json({
            status: 'done',
            transcript: [],
            analysis: {
              data_collection_results: {
                winning_line: { value: 'a sentence from the callee' },
              },
            },
          })
        : ok()) as unknown as typeof fetch;
    const { app, lines } = appWith();
    const res = await post(app, {
      target: 'sam',
      keyword: 'otter',
      wait: true,
    });
    expect(await res.json()).toMatchObject({
      result: { winningLine: 'a sentence from the callee' },
    });
    expect(lines.join('\n')).not.toContain('a sentence from the callee');
  });

  test('a failed call answers 502 and polls nothing', async () => {
    const calls = mockElevenLabs(failing);
    const { app } = appWith();
    const res = await post(app, { target: 'sam', keyword: 'otter' });
    expect(res.status).toBe(502);
    expect(calls).toHaveLength(1);
  });
});

describe('/mission/rehearse', () => {
  const targets = new Map([['sam', '+15555550123']]);
  const mission = { agentId: 'agent_mission', targets };
  const auth = { authorization: 'Bearer mission-secret' };

  const rehearse = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request('/mission/rehearse', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  function mockSimulation(status = 200) {
    const sent: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: String(init.body) });
      if (status !== 200) return new Response('nope', { status });
      return Response.json({
        simulated_conversation: [
          { role: 'agent', message: 'Hi, is this Sam?', time_in_call_secs: 0 },
          { role: 'user', message: 'Speaking.', time_in_call_secs: 2 },
          { role: 'user', message: 'We do otters here', time_in_call_secs: 9 },
        ],
      });
    }) as unknown as typeof fetch;
    return sent;
  }

  function appWith() {
    const { log, lines } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      mission,
      now: clock(DAYTIME).fn,
      sleep: async () => {},
    });
    return { app, lines };
  }

  test('simulates with the mission variables and scores the transcript', async () => {
    const sent = mockSimulation();
    const { app, lines } = appWith();
    const res = await rehearse(app, {
      target: 'sam',
      keyword: 'otter',
      scenario: 'a cover story',
      callee: 'a wary callee',
      turns: 6,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      rehearsal: true,
      result: {
        won: true,
        turn: 2,
        secondsToWin: 9,
        winningLine: 'We do otters here',
        transcript: [
          { role: 'agent', secs: 0, message: 'Hi, is this Sam?' },
          { role: 'user', secs: 2, message: 'Speaking.' },
          { role: 'user', secs: 9, message: 'We do otters here' },
        ],
      },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toContain(
      '/agents/agent_mission/simulate-conversation',
    );
    const body = JSON.parse(sent[0]?.body ?? '{}');
    expect(body.new_turns_limit).toBe(6);
    expect(body.simulation_specification.dynamic_variables).toEqual({
      target_name: 'Sam',
      keyword: 'otter',
      objective: DEFAULT_OBJECTIVE,
      scenario: 'a cover story',
    });
    expect(
      body.simulation_specification.simulated_user_config.prompt.prompt,
    ).toBe('a wary callee');
    const all = lines.join('\n');
    expect(all).toContain('"rehearsal result"');
    expect(all).not.toContain('We do otters here');
    expect(all).not.toContain('5555550123');
  });

  test('needs no target, dials nothing and ignores the daily cap', async () => {
    const sent = mockSimulation();
    const { app } = appWith();
    for (let i = 0; i < 4; i++) {
      const res = await rehearse(app, { keyword: 'otter', name: 'Pat' });
      expect(res.status).toBe(200);
    }
    expect(sent).toHaveLength(4);
    for (const call of sent) {
      expect(call.url).not.toContain('outbound-call');
      expect(
        JSON.parse(call.body).simulation_specification.dynamic_variables
          .target_name,
      ).toBe('Pat');
    }
  });

  test('clamps turns and refuses a bad keyword or unknown target', async () => {
    const sent = mockSimulation();
    const { app } = appWith();
    expect((await rehearse(app, { keyword: 'ot7er' })).status).toBe(400);
    expect(
      (await rehearse(app, { keyword: 'otter', target: 'nobody' })).status,
    ).toBe(404);
    expect(sent).toHaveLength(0);
    await rehearse(app, { keyword: 'otter', turns: 900 });
    expect(JSON.parse(sent[0]?.body ?? '{}').new_turns_limit).toBe(
      REHEARSAL_TURNS_MAX,
    );
    await rehearse(app, { keyword: 'otter', turns: 'lots' });
    expect(JSON.parse(sent[1]?.body ?? '{}').new_turns_limit).toBe(
      REHEARSAL_TURNS,
    );
  });

  test('a failed simulation answers 502, and no bearer 401', async () => {
    mockSimulation(500);
    const { app } = appWith();
    expect((await rehearse(app, { keyword: 'otter' })).status).toBe(502);
    const res = await app.request('/mission/rehearse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyword: 'otter' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('/persona', () => {
  type Loose = Record<string, Record<string, unknown>>;
  const json = (res: Response) => res.json() as Promise<Loose>;
  const liveAgent = {
    agent_id: 'agent_troll',
    conversation_config: {
      agent: {
        first_message: 'Yeah. Who is this?',
        prompt: { prompt: 'You are Jonathan.', llm: 'gemini-3.5-flash-lite' },
      },
      tts: { voice_id: 'B3MaEpg3jVTwjxbDmLJE', stability: 0.5 },
    },
  };
  const fileInGit = {
    name: 'pbx-troll',
    conversation_config: {
      agent: {
        first_message: 'Yeah. Who is this?',
        prompt: { prompt: 'You are Jonathan.', llm: 'gemini-3.5-flash-lite' },
      },
      tts: { voice_id: 'B3MaEpg3jVTwjxbDmLJE', stability: 0.5 },
    },
    platform_settings: { data_collection: {} },
  };

  function fakeGithub(content = `${JSON.stringify(fileInGit, null, 2)}\n`) {
    const opened: unknown[] = [];
    return {
      opened,
      github: {
        readFile: async () => ({ content, sha: 'blob1' }),
        openSnapshot: async (snapshot: unknown) => {
          opened.push(snapshot);
          return {
            url: 'https://github.com/o/r/pull/9',
            number: 9,
            autoMerge: true,
          };
        },
      },
    };
  }

  /** ElevenLabs: a GET answers the agent, a PATCH applies the body to it. */
  function mockAgent(start: Record<string, unknown>) {
    let agent = structuredClone(start);
    const calls: { method: string; url: string; body: unknown }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url: String(url), body });
      if (method === 'PATCH') {
        const patch = body.conversation_config ?? {};
        const config = agent.conversation_config as Record<
          string,
          Record<string, unknown>
        >;
        for (const [section, leaves] of Object.entries(patch)) {
          const current = config[section] ?? {};
          for (const [key, value] of Object.entries(
            leaves as Record<string, unknown>,
          )) {
            current[key] =
              key === 'prompt' && typeof value === 'object'
                ? { ...(current.prompt as object), ...(value as object) }
                : value;
          }
          config[section] = current;
        }
        return Response.json({});
      }
      if (String(url).includes('/simulate-conversation')) {
        return Response.json({
          simulated_conversation: [
            { role: 'agent', message: 'Yeah. Who is this?' },
            { role: 'user', message: 'Hi! Brittany here!' },
            { role: 'agent', message: '[annoyed] What do you want.' },
          ],
        });
      }
      return Response.json(agent);
    }) as unknown as typeof fetch;
    return {
      calls,
      current: () => agent,
      reset: () => (agent = structuredClone(start)),
    };
  }

  const persona = (github?: ReturnType<typeof fakeGithub>['github']) => ({
    agents: new Map([['pbx-troll', 'agent_troll']]),
    github,
    dir: 'clusters/offsite/apps/elevenlabs/desired/agents',
    base: 'main',
  });
  const auth = {
    authorization: 'Bearer persona-secret',
    'content-type': 'application/json',
  };

  test('answers 503 without the deps or the token, 401 with the wrong bearer', async () => {
    const { log } = fakeLog();
    const off = createApp({ config: baseConfig, log });
    expect((await off.request('/persona', { headers: auth })).status).toBe(503);
    const noToken = createApp({
      config: { ...baseConfig, personaToken: undefined },
      log,
      persona: persona(),
    });
    expect((await noToken.request('/persona', { headers: auth })).status).toBe(
      503,
    );
    const on = createApp({ config: baseConfig, log, persona: persona() });
    expect((await on.request('/persona')).status).toBe(401);
    expect(
      (
        await on.request('/persona/pbx-troll', {
          method: 'PATCH',
          headers: { authorization: 'Bearer nope' },
          body: '{}',
        })
      ).status,
    ).toBe(401);
  });

  test('lists the agents and reads a persona', async () => {
    mockAgent(liveAgent);
    const { log } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      persona: persona(fakeGithub().github),
    });
    const list = await app.request('/persona', { headers: auth });
    expect(await list.json()).toEqual({
      agents: [{ name: 'pbx-troll', agentId: 'agent_troll' }],
      snapshot: true,
    });
    const read = await app.request('/persona/pbx-troll', { headers: auth });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      name: 'pbx-troll',
      persona: {
        first_message: 'Yeah. Who is this?',
        prompt: 'You are Jonathan.',
        tts: { voice_id: 'B3MaEpg3jVTwjxbDmLJE', stability: 0.5 },
      },
    });
    expect(
      (await app.request('/persona/pbx-nobody', { headers: auth })).status,
    ).toBe(404);
  });

  test('a patch writes only persona leaves live, then snapshots the file', async () => {
    const live = mockAgent(liveAgent);
    const gh = fakeGithub();
    const { log, lines } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      persona: persona(gh.github),
      now: () => new Date('2026-10-10T21:04:05Z').getTime(),
    });
    const res = await app.request('/persona/pbx-troll', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({
        prompt: 'You are Jonathan, and grumpy.',
        tts: { stability: 0.6 },
      }),
    });
    expect(res.status).toBe(200);
    const answer = await json(res);
    expect(answer.persona).toEqual({
      first_message: 'Yeah. Who is this?',
      prompt: 'You are Jonathan, and grumpy.',
      tts: { voice_id: 'B3MaEpg3jVTwjxbDmLJE', stability: 0.6 },
    });
    expect(answer.snapshot).toEqual({
      status: 'opened',
      url: 'https://github.com/o/r/pull/9',
      autoMerge: true,
    });

    const patch = live.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      conversation_config: {
        agent: { prompt: { prompt: 'You are Jonathan, and grumpy.' } },
        tts: { stability: 0.6 },
      },
    });
    expect(gh.opened).toHaveLength(1);
    const snapshot = gh.opened[0] as {
      path: string;
      branch: string;
      content: string;
      base: string;
    };
    expect(snapshot.path).toBe(
      'clusters/offsite/apps/elevenlabs/desired/agents/pbx-troll.json',
    );
    expect(snapshot.branch).toBe('persona/pbx-troll-20261010210405');
    expect(snapshot.base).toBe('main');
    const written = JSON.parse(snapshot.content);
    expect(written.conversation_config.agent.prompt).toEqual({
      prompt: 'You are Jonathan, and grumpy.',
      llm: 'gemini-3.5-flash-lite',
    });
    expect(written.conversation_config.tts.stability).toBe(0.6);
    expect(written.platform_settings).toEqual({ data_collection: {} });
    expect(snapshot.content.endsWith('\n')).toBe(true);
    const logged = lines.find((l) => l.includes('persona patched'));
    expect(logged).toContain('"leaves":["prompt","tts.stability"]');
    expect(logged).not.toContain('grumpy');
  });

  test('a patch with a key outside the persona is refused before any write', async () => {
    const live = mockAgent(liveAgent);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log, persona: persona() });
    const res = await app.request('/persona/pbx-troll', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({
        prompt: 'x',
        platform_settings: { call_limits: { daily_limit: 999 } },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown key platform_settings',
    });
    expect(live.calls).toHaveLength(0);
  });

  test('without the github app the edit stands and the snapshot is skipped', async () => {
    mockAgent(liveAgent);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log, persona: persona() });
    const res = await app.request('/persona/pbx-troll', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ first_message: 'What.' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).snapshot).toEqual({
      status: 'skipped',
      reason: 'no github app',
    });
  });

  test('a snapshot of a live persona that matches git opens nothing', async () => {
    mockAgent(liveAgent);
    const gh = fakeGithub();
    const { log } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      persona: persona(gh.github),
    });
    const res = await app.request('/persona/pbx-troll/snapshot', {
      method: 'POST',
      headers: auth,
    });
    expect(res.status).toBe(200);
    expect((await json(res)).snapshot).toEqual({ status: 'unchanged' });
    expect(gh.opened).toHaveLength(0);
  });

  test('a snapshot after a dashboard edit opens the pull request', async () => {
    mockAgent({
      ...liveAgent,
      conversation_config: {
        ...liveAgent.conversation_config,
        agent: {
          ...liveAgent.conversation_config.agent,
          first_message: 'Edited in the dashboard.',
        },
      },
    });
    const gh = fakeGithub();
    const { log } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      persona: persona(gh.github),
    });
    const res = await app.request('/persona/pbx-troll/snapshot', {
      method: 'POST',
      headers: auth,
    });
    expect((await json(res)).snapshot?.status).toBe('opened');
    const written = JSON.parse((gh.opened[0] as { content: string }).content);
    expect(written.conversation_config.agent.first_message).toBe(
      'Edited in the dashboard.',
    );
  });

  test('a failed github call leaves the live edit and reports the failure', async () => {
    mockAgent(liveAgent);
    const { log, lines } = fakeLog();
    const app = createApp({
      config: baseConfig,
      log,
      persona: persona({
        readFile: async () => {
          throw new Error('read: HTTP 500');
        },
        openSnapshot: async () => {
          throw new Error('never');
        },
      }),
    });
    const res = await app.request('/persona/pbx-troll', {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ first_message: 'What.' }),
    });
    expect(res.status).toBe(200);
    expect((await json(res)).snapshot).toEqual({
      status: 'failed',
      reason: 'read: HTTP 500',
    });
    expect(lines.some((l) => l.includes('persona snapshot failed'))).toBe(true);
  });

  test('a rehearsal answers the transcript and the tags the agent used', async () => {
    const live = mockAgent(liveAgent);
    const { log } = fakeLog();
    const app = createApp({ config: baseConfig, log, persona: persona() });
    const res = await app.request('/persona/pbx-troll/rehearse', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        caller: 'A bubbly telemarketer.',
        first_message: 'Hi there!',
        turns: 6,
        dynamic_variables: { sip_pbx_mode: 'troll' },
      }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      name: 'pbx-troll',
      transcript: [
        { role: 'agent', message: 'Yeah. Who is this?' },
        { role: 'user', message: 'Hi! Brittany here!' },
        { role: 'agent', message: '[annoyed] What do you want.' },
      ],
      tags: ['annoyed'],
    });
    const sent = live.calls.find((c) =>
      c.url.includes('/simulate-conversation'),
    )?.body;
    expect(sent).toEqual({
      simulation_specification: {
        simulated_user_config: {
          first_message: 'Hi there!',
          language: 'en',
          prompt: { prompt: 'A bubbly telemarketer.' },
        },
        dynamic_variables: { sip_pbx_mode: 'troll' },
      },
      new_turns_limit: 6,
    });
    const noCaller = await app.request('/persona/pbx-troll/rehearse', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ turns: 4 }),
    });
    expect(noCaller.status).toBe(400);
  });
});
