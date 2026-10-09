import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Config, readConfig } from '../src/config.ts';
import type { Fields, Log } from '../src/log.ts';
import { resolveMission } from '../src/ring.ts';
import { createApp } from '../src/server.ts';

const original = globalThis.fetch;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ring-'));
  writeFileSync(join(dir, 'sam'), '+15555550123');
});
afterEach(() => {
  globalThis.fetch = original;
  rmSync(dir, { recursive: true, force: true });
});

function fakeLog() {
  const lines: string[] = [];
  const capture = (msg: string, fields?: Fields) =>
    lines.push(JSON.stringify({ msg, ...fields }));
  const log: Log = { info: capture, warn: capture, error: capture };
  return { log, lines };
}

const config = (): Config =>
  readConfig({
    ELEVENLABS_API_KEY: 'key',
    SWITCHBOARD_PHONE_NUMBER_ID: 'phnum_1',
    SWITCHBOARD_TO_NUMBER: '+15555550100',
    SWITCHBOARD_RING_TOKEN: 'ring-secret',
    SWITCHBOARD_ALERT_TOKEN: 'alert-secret',
    SWITCHBOARD_MISSION_TOKEN: 'mission-secret',
    SWITCHBOARD_TARGETS_DIR: dir,
  });

const listAgents = (...agents: { agent_id: string; name: string }[]) => {
  globalThis.fetch = (async () =>
    Response.json({ agents, has_more: false })) as unknown as typeof fetch;
};

describe('resolveMission', () => {
  test('a missing mission agent turns missions off and the ringer still serves', async () => {
    listAgents({ agent_id: 'agent_1', name: 'pbx-switchboard' });
    const { log, lines } = fakeLog();
    const cfg = config();
    const mission = await resolveMission(cfg, log);
    expect(mission).toBeUndefined();
    const off = lines.find((l) => l.includes('"missions off"'));
    expect(off).toContain('SWITCHBOARD_MISSION_AGENT_NAME');
    expect(off).not.toContain('5555550123');

    const app = createApp({
      config: { ...cfg, agentId: 'agent_1' },
      log,
      mission,
    });
    const res = await app.request('/mission', {
      method: 'POST',
      headers: { authorization: 'Bearer mission-secret' },
      body: JSON.stringify({ target: 'sam', keyword: 'otter' }),
    });
    expect(res.status).toBe(503);
  });

  test('an ambiguous mission agent also turns missions off', async () => {
    listAgents(
      { agent_id: 'a', name: 'pbx-mission' },
      { agent_id: 'b', name: 'pbx-mission' },
    );
    const { log } = fakeLog();
    expect(await resolveMission(config(), log)).toBeUndefined();
  });

  test('a found agent turns missions on with the targets', async () => {
    listAgents({ agent_id: 'agent_m', name: 'pbx-mission' });
    const { log } = fakeLog();
    const mission = await resolveMission(config(), log);
    expect(mission?.agentId).toBe('agent_m');
    expect([...(mission?.targets.keys() ?? [])]).toEqual(['sam']);
  });

  test('no token means no lookup at all', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ agents: [] });
    }) as unknown as typeof fetch;
    const { log } = fakeLog();
    const cfg = { ...config(), missionToken: undefined };
    expect(await resolveMission(cfg, log)).toBeUndefined();
    expect(calls).toBe(0);
  });
});
