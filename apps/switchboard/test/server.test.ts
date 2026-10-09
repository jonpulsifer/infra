import { afterEach, describe, expect, test } from 'bun:test';
import type { ResolvedConfig } from '../src/config.ts';
import type { Fields, Log } from '../src/log.ts';
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
    expect(sent.to_number).toBe('+19025551234');
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
    expect(body.to_number).toBe('+15555550123');
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
