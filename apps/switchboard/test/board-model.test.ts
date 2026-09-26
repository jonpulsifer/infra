import { describe, expect, test } from 'bun:test';
import type { RecentCall } from '../src/board/model.ts';
import { BoardModel } from '../src/board/model.ts';
import type { ChannelOpts } from './board-fixtures.ts';
import { at, channel, ev, PLAN } from './board-fixtures.ts';

const NOW = Date.parse(at(0));

function model(ended: RecentCall[] = []) {
  return new BoardModel({
    plan: PLAN,
    recentLimit: 3,
    now: () => NOW,
    onEnded: (call) => ended.push(call),
  });
}

const STRANGER = { name: 'WIRELESS CALLER', number: '6135550108' };
const LINE4_TRUNK: ChannelOpts = {
  vars: { HANDSET: 'line4', SCREEN: 'yes' },
  caller: STRANGER,
};

// A caller on line 4 walking the dialplan, one ChannelDialplan per step.
function walk(
  m: BoardModel,
  id: string,
  name: string,
  steps: [number, string, string, string, string?][],
  base: ChannelOpts = LINE4_TRUNK,
) {
  for (const [t, context, exten, app, data] of steps) {
    m.apply(
      ev('ChannelDialplan', t, {
        channel: channel(id, name, {
          ...base,
          state: t > 1 ? 'Up' : 'Ring',
          context,
          exten,
          app,
          data,
        }),
      }),
    );
  }
}

const stageOf = (m: BoardModel) => m.snapshot().calls[0]?.stage.label;

describe('the board model', () => {
  test('follows a screened stranger into a sink and into recent', () => {
    const ended: RecentCall[] = [];
    const m = model(ended);
    const trunk = 'PJSIP/vms-1994-00000001';
    m.apply(
      ev('ChannelCreated', 0, {
        channel: channel('1.1', trunk, {
          ...LINE4_TRUNK,
          context: 'from-voipms',
          exten: '9028261994',
        }),
      }),
    );
    expect(stageOf(m)).toBe('arrived');
    walk(m, '1.1', trunk, [
      [0, 'from-voipms', 's', 'NoOp'],
      [0, 'from-voipms', 's', 'Gosub', 'pbx-event,s,1(inbound)'],
      [0, 'pbx-event', 's', 'Log', 'NOTICE,pbx-event kind=inbound'],
      [
        2,
        'from-voipms',
        's',
        'Read',
        'DIGIT,/var/lib/pbx-sounds/captcha-greeting,1,,1,6',
      ],
    ]);
    expect(stageOf(m)).toBe('press-5 prompt');
    walk(m, '1.1', trunk, [
      [
        8,
        'from-voipms',
        's',
        'Read',
        'DIGIT,/var/lib/pbx-sounds/captcha-retry,1,,1,6',
      ],
    ]);
    expect(stageOf(m)).toBe('press-5 prompt, second try');
    walk(m, '1.1', trunk, [
      [14, 'from-voipms', 's', 'Gosub', 'pbx-event,s,1(screened)'],
      [14, 'spam', 's', 'Set', 'TIMEOUT(absolute)=600'],
    ]);
    expect(stageOf(m)).toBe('into the sinks');
    walk(m, '1.1', trunk, [
      [15, 'spam', 's', 'Gosub', 'pbx-event,s,1(lenny)'],
      [15, 'spam', 'lenny', 'Playback', '/var/lib/pbx-sounds/lenny-hello'],
    ]);
    const call = m.snapshot().calls[0];
    expect(call).toMatchObject({
      direction: 'inbound',
      line: 'line4',
      trunk: 'vms-1994',
      caller: STRANGER,
      verdict: 'screened',
      trail: ['inbound', 'screened', 'lenny'],
      stage: { key: 'held', label: 'held: Robo-Lenny' },
    });
    // The hangup handler is a subroutine and leaves the stage where it was.
    walk(m, '1.1', trunk, [
      [75, 'spam-held', 's', 'Gosub', 'pbx-event,s,1(held,secs=60,sink=lenny)'],
    ]);
    m.apply(
      ev('ChannelDestroyed', 75, {
        channel: channel('1.1', trunk, LINE4_TRUNK),
        cause: 16,
        cause_txt: 'Normal Clearing',
      }),
    );
    const view = m.snapshot();
    expect(view.calls).toHaveLength(0);
    expect(view.recent[0]).toMatchObject({
      verdict: 'screened',
      lastStage: 'held: Robo-Lenny',
      seconds: 75,
      talkedSeconds: 0,
      cause: 16,
      causeText: 'Normal Clearing',
    });
    expect(ended).toHaveLength(1);
  });

  test('a caller who presses 5 rings the desk and then talks on the line', () => {
    const m = model();
    const trunk = 'PJSIP/vms-1994-00000002';
    const desk = 'PJSIP/line4-00000003';
    walk(m, '2.1', trunk, [
      [0, 'from-voipms', 's', 'NoOp'],
      [3, 'from-voipms', 'human', 'Gosub', 'pbx-event,s,1(captcha-pass)'],
      [
        3,
        'from-voipms',
        'human',
        'Dial',
        'PJSIP/line4,25,mb(handset-leg^s^1(Human))',
      ],
    ]);
    m.apply(
      ev('Dial', 3, {
        caller: channel('2.1', trunk, {
          ...LINE4_TRUNK,
          context: 'from-voipms',
          exten: 'human',
          app: 'Dial',
        }),
        peer: channel('2.2', desk, {
          context: 'handset-leg',
          exten: 's',
          created: 3,
        }),
        dialstatus: '',
      }),
    );
    let view = m.snapshot();
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]?.stage.label).toBe('pressed 5 → ringing desk');
    expect(view.calls[0]?.verdict).toBe('pressed 5');
    const bridge = { id: 'b1', channels: ['2.2'] };
    m.apply(
      ev('ChannelEnteredBridge', 9, {
        channel: channel('2.2', desk, {
          state: 'Up',
          app: 'AppDial',
          created: 3,
        }),
        bridge,
      }),
    );
    m.apply(
      ev('ChannelEnteredBridge', 9, {
        channel: channel('2.1', trunk, {
          ...LINE4_TRUNK,
          state: 'Up',
          context: 'from-voipms',
          exten: 'human',
          app: 'Dial',
        }),
        bridge: { id: 'b1', channels: ['2.2', '2.1'] },
      }),
    );
    view = m.snapshot();
    expect(view.calls[0]?.stage).toEqual({
      key: 'talking',
      label: 'talking on line4',
    });
    expect(view.calls[0]?.talkingSince).toBe(
      new Date(Date.parse(at(9))).toISOString(),
    );
    expect(view.lines.find((l) => l.line === 'line4')?.calls).toBe(1);
    m.apply(
      ev('ChannelLeftBridge', 70, {
        channel: channel('2.2', desk),
        bridge: { id: 'b1', channels: ['2.1'] },
      }),
    );
    m.apply(
      ev('ChannelDestroyed', 70, {
        channel: channel('2.2', desk),
        cause: 16,
        cause_txt: 'Normal Clearing',
      }),
    );
    m.apply(
      ev('ChannelLeftBridge', 70, {
        channel: channel('2.1', trunk),
        bridge: { id: 'b1', channels: [] },
      }),
    );
    m.apply(
      ev('ChannelDestroyed', 70, {
        channel: channel('2.1', trunk),
        cause: 16,
        cause_txt: 'Normal Clearing',
      }),
    );
    view = m.snapshot();
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0]).toMatchObject({
      lastStage: 'talked with line4',
      seconds: 70,
      talkedSeconds: 61,
    });
  });

  test('a contact rings through with its verdict', () => {
    const m = model();
    walk(
      m,
      '3.1',
      'PJSIP/vms-1994-00000004',
      [
        [0, 'from-voipms', 's', 'GotoIf', '1?contact,1'],
        [0, 'from-voipms', 'contact', 'Gosub', 'pbx-event,s,1(contact)'],
        [
          0,
          'from-voipms',
          'ring',
          'Dial',
          'PJSIP/line4,25,b(handset-leg^s^1(Friend))',
        ],
      ],
      { vars: { HANDSET: 'line4', SCREEN: 'yes', CONTACT: 'Mum' } },
    );
    expect(m.snapshot().calls[0]).toMatchObject({
      verdict: 'contact',
      stage: { label: 'contact → ringing desk' },
    });
  });

  test('an unscreened line and a 911 callback ring unanswered', () => {
    const m = model();
    walk(
      m,
      '4.1',
      'PJSIP/vms-cathy-00000005',
      [[0, 'from-voipms', 'ring', 'Dial']],
      {
        vars: { HANDSET: 'line1' },
      },
    );
    walk(
      m,
      '4.2',
      'PJSIP/vms-1994-00000006',
      [[1, 'from-voipms', 'ring', 'Dial']],
      {
        vars: { HANDSET: 'line4', SCREEN: 'yes' },
      },
    );
    const [open, callback] = m.snapshot().calls;
    expect(open).toMatchObject({
      line: 'line1',
      verdict: 'open line',
      stage: { label: 'ringing desk (unscreened line)' },
    });
    expect(callback).toMatchObject({
      verdict: '911 callback',
      stage: { label: 'ringing desk (911 callback)' },
    });
  });

  test('a caller over a cap is refused', () => {
    const m = model();
    walk(m, '5.1', 'PJSIP/vms-1994-00000007', [
      [0, 'from-voipms', 'busy', 'Hangup', '17'],
    ]);
    walk(m, '5.2', 'PJSIP/vms-1994-00000008', [
      [0, 'spam', 'full', 'Playback'],
    ]);
    const [busy, full] = m.snapshot().calls;
    expect(busy).toMatchObject({
      verdict: 'refused (busy)',
      stage: { key: 'refused', label: 'refused (busy)' },
    });
    expect(full).toMatchObject({
      verdict: 'refused (full)',
      stage: { label: 'refused (full)' },
    });
  });

  test('a handset call dials out, then talks, on its own trunk', () => {
    const m = model();
    const line = 'PJSIP/line1-00000009';
    const opts: ChannelOpts = {
      vars: { TRUNK: 'vms-cathy' },
      caller: { name: 'Office', number: 'line1' },
    };
    walk(
      m,
      '6.1',
      line,
      [
        [
          0,
          'from-handset',
          '6135550123',
          'Dial',
          'PJSIP/6135550123@vms-cathy,60',
        ],
      ],
      opts,
    );
    m.apply(
      ev('Dial', 0, {
        caller: channel('6.1', line, {
          ...opts,
          context: 'from-handset',
          exten: '6135550123',
        }),
        peer: channel('6.2', 'PJSIP/vms-cathy-0000000a'),
        dialstatus: 'RINGING',
      }),
    );
    expect(m.snapshot().calls[0]).toMatchObject({
      direction: 'handset',
      line: 'line1',
      trunk: 'vms-cathy',
      dialled: '6135550123',
      stage: { key: 'outbound', label: 'outbound to 6135550123 via vms-cathy' },
    });
    m.apply(
      ev('ChannelEnteredBridge', 5, {
        channel: channel('6.2', 'PJSIP/vms-cathy-0000000a'),
        bridge: { id: 'b2', channels: ['6.2'] },
      }),
    );
    m.apply(
      ev('ChannelEnteredBridge', 5, {
        channel: channel('6.1', line, {
          ...opts,
          context: 'from-handset',
          exten: '6135550123',
        }),
        bridge: { id: 'b2', channels: ['6.2', '6.1'] },
      }),
    );
    expect(stageOf(m)).toBe('talking to 6135550123 via vms-cathy');
  });

  test('handset codes read as toys, the sinks included', () => {
    const m = model();
    walk(m, '7.1', 'PJSIP/line2-0000000b', [[0, 'toybox', 'echo', 'Echo']], {
      vars: { TRUNK: 'vms-recorded' },
    });
    walk(m, '7.2', 'PJSIP/line3-0000000c', [[1, 'spam', 'lenny', 'Playback']], {
      vars: { TRUNK: 'vms-sandbox' },
    });
    expect(m.snapshot().calls.map((c) => c.stage.label)).toEqual([
      'toy: echo',
      'toy: Robo-Lenny',
    ]);
  });

  test('the troll line reads as Earl, and a context it does not know by name', () => {
    const m = model();
    walk(m, '8.1', 'PJSIP/vms-1994-0000000d', [[0, 'agent', 's', 'Dial']]);
    walk(m, '8.2', 'PJSIP/vms-1994-0000000e', [
      [1, 'party-line', 's', 'Playback'],
    ]);
    expect(m.snapshot().calls.map((c) => c.stage)).toEqual([
      { key: 'agent', label: 'with Earl' },
      { key: 'other', label: 'in party-line' },
    ]);
  });

  test('a screened caller talks with Earl through the hangup handler and into recent', () => {
    const m = model();
    const trunk = 'PJSIP/vms-1994-00000040';
    const agent = 'PJSIP/elevenlabs-00000041';
    walk(m, '14.1', trunk, [
      [0, 'from-voipms', 's', 'NoOp'],
      [14, 'from-voipms', 's', 'Gosub', 'pbx-event,s,1(screened)'],
      [14, 'agent', 's', 'Set', 'AGENT_MODE=troll'],
      [14, 'agent', 'dial', 'Gosub', 'pbx-event,s,1(troll,mode=troll)'],
      [
        14,
        'agent',
        'dial',
        'Dial',
        'PJSIP/19025550100@elevenlabs,60,b(agent-leg^s^1(troll^14.1^6135550108))S(600)',
      ],
    ]);
    m.apply(
      ev('Dial', 14, {
        caller: channel('14.1', trunk, {
          ...LINE4_TRUNK,
          context: 'agent',
          exten: 'dial',
          app: 'Dial',
        }),
        peer: channel('14.2', agent, {
          context: 'agent-leg',
          exten: 's',
          created: 14,
        }),
      }),
    );
    expect(m.snapshot().calls).toHaveLength(1);
    expect(stageOf(m)).toBe('with Earl');
    m.apply(
      ev('ChannelEnteredBridge', 16, {
        channel: channel('14.2', agent, { state: 'Up', app: 'AppDial' }),
        bridge: { id: 'b3', channels: ['14.2'] },
      }),
    );
    m.apply(
      ev('ChannelEnteredBridge', 16, {
        channel: channel('14.1', trunk, {
          ...LINE4_TRUNK,
          state: 'Up',
          context: 'agent',
          exten: 'dial',
          app: 'Dial',
        }),
        bridge: { id: 'b3', channels: ['14.2', '14.1'] },
      }),
    );
    expect(m.snapshot().calls[0]).toMatchObject({
      verdict: 'screened',
      trail: ['screened', 'troll'],
      stage: { key: 'agent', label: 'with Earl' },
    });
    m.apply(
      ev('ChannelLeftBridge', 76, {
        channel: channel('14.1', trunk),
        bridge: { id: 'b3', channels: ['14.2'] },
      }),
    );
    // agent.conf's hangup handler logs the call without moving it.
    walk(m, '14.1', trunk, [
      [
        76,
        'agent-held',
        's',
        'Gosub',
        'pbx-event,s,1(held,secs=62,sink=troll)',
      ],
    ]);
    expect(stageOf(m)).toBe('with Earl');
    m.apply(
      ev('ChannelDestroyed', 76, {
        channel: channel('14.1', trunk),
        cause: 16,
        cause_txt: 'Normal Clearing',
      }),
    );
    expect(m.snapshot().recent[0]).toMatchObject({
      lastStage: 'talked with Earl',
      trail: ['screened', 'troll', 'held'],
      talkedSeconds: 60,
    });
  });

  test('a caller Earl does not take falls back to the sinks', () => {
    const m = model();
    walk(m, '15.1', 'PJSIP/vms-1994-00000042', [
      [0, 'agent', 'dial', 'Set', 'AGENT_MISS=off'],
      [
        0,
        'agent',
        'miss',
        'Gosub',
        'pbx-event,s,1(troll-miss,mode=troll,why=off)',
      ],
      [0, 'spam', 's', 'Set', 'TIMEOUT(absolute)=600'],
      [1, 'spam', 'queue', 'Playback'],
    ]);
    expect(m.snapshot().calls[0]).toMatchObject({
      trail: ['troll-miss'],
      stage: { key: 'held', label: 'held: Endless Queue' },
    });
  });

  test('a variable set takes effect before the next snapshot shows it', () => {
    const m = model();
    const name = 'PJSIP/vms-1994-0000000f';
    walk(m, '9.1', name, [[0, 'from-voipms', 's', 'Set']], {
      vars: { HANDSET: 'line4', SCREEN: 'yes' },
    });
    // The snapshot on a ChannelVarset predates the Set it reports.
    m.apply(
      ev('ChannelVarset', 0, {
        channel: channel('9.1', name, {
          vars: { HANDSET: 'line4', SCREEN: 'yes' },
          context: 'from-voipms',
          exten: 's',
        }),
        variable: 'CONTACT',
        value: 'Mum',
      }),
    );
    m.apply(
      ev('ChannelVarset', 0, {
        channel: channel('9.1', name, {
          vars: { HANDSET: 'line4', SCREEN: 'yes' },
          context: 'from-voipms',
          exten: 's',
        }),
        variable: 'LOCAL(msg)',
        value: 'x',
      }),
    );
    walk(m, '9.1', name, [[0, 'from-voipms', 'ring', 'Dial']], {
      vars: { HANDSET: 'line4', SCREEN: 'yes', CONTACT: 'Mum' },
    });
    expect(stageOf(m)).toBe('contact → ringing desk');
  });

  test('counts the callers the sinks have eaten from the global', () => {
    const m = model();
    expect(m.snapshot().eaten).toBeNull();
    m.apply(ev('ChannelVarset', 0, { variable: 'EATEN', value: '7' }));
    expect(m.snapshot().eaten).toBe(7);
  });

  test('a resync replaces the channels and ends the ones that vanished', () => {
    const ended: RecentCall[] = [];
    const m = model(ended);
    walk(m, '10.1', 'PJSIP/vms-1994-00000010', [
      [0, 'spam', 'queue', 'Playback'],
    ]);
    m.load(
      {
        channels: [
          channel('11.1', 'PJSIP/vms-cathy-00000011', {
            context: 'from-voipms',
            exten: 'ring',
            app: 'Dial',
            vars: { HANDSET: 'line1' },
          }),
          // Dial's outgoing leg, known by its app although no Dial event was seen.
          channel('11.2', 'PJSIP/line1-00000012', {
            app: 'AppDial',
            data: '(Outgoing Line)',
          }),
        ],
        bridges: [],
        endpoints: [
          { technology: 'PJSIP', resource: 'line1', state: 'online' },
        ],
      },
      NOW + 1,
    );
    const view = m.snapshot();
    expect(view.calls.map((c) => c.id)).toEqual(['11.1']);
    expect(ended.map((c) => [c.id, c.cause])).toEqual([['10.1', null]]);
    expect(view.lines[0]?.handset).toBe('online');
  });

  test('a resync neither ends a call newer than its lists nor revives a dead one', () => {
    let now = NOW;
    const ended: RecentCall[] = [];
    const m = new BoardModel({
      plan: PLAN,
      recentLimit: 5,
      now: () => now,
      onEnded: (call) => ended.push(call),
    });
    const old = 'PJSIP/vms-1994-00000030';
    walk(m, '13.1', old, [[0, 'spam', 'queue', 'Playback']]);
    const since = now;
    now += 50;
    // Started while the lists were in flight: ARI's lists predate it.
    walk(
      m,
      '13.2',
      'PJSIP/vms-cathy-00000031',
      [[0, 'from-voipms', 's', 'NoOp']],
      {
        vars: { HANDSET: 'line1' },
      },
    );
    // Ended while the lists were in flight: ARI's lists still show it.
    m.apply(
      ev('ChannelDestroyed', 1, { channel: channel('13.1', old), cause: 16 }),
    );
    m.load(
      {
        channels: [channel('13.1', old, { context: 'spam', exten: 'queue' })],
        bridges: [],
      },
      since,
    );
    expect(m.snapshot().calls.map((c) => c.id)).toEqual(['13.2']);
    expect(ended.map((c) => c.id)).toEqual(['13.1']);
  });

  test('shows each line with its handset, trunk registration and use', () => {
    const m = model();
    m.setMetrics({
      registrations: {
        '168847_cathy': 'registered',
        '168847_sandbox': 'rejected',
      },
      endpoints: { line1: 'online', line2: 'offline' },
      version: '22.8.2',
      uptimeSeconds: 60,
    });
    m.apply(
      ev('EndpointStateChange', 0, {
        endpoint: { technology: 'PJSIP', resource: 'line2', state: 'online' },
      }),
    );
    m.apply(
      ev('ContactStatusChange', 0, {
        endpoint: { resource: 'line2' },
        contact_info: {
          aor: 'line2',
          contact_status: 'Reachable',
          roundtrip_usec: '12400',
        },
      }),
    );
    const view = m.snapshot();
    expect(
      view.lines.map((l) => [
        l.line,
        l.handset,
        l.registration,
        l.handsetRttMs,
      ]),
    ).toEqual([
      ['line1', 'online', 'registered', null],
      ['line2', 'online', 'unknown', 12],
      ['line3', 'unknown', 'rejected', null],
      ['line4', 'unknown', 'unknown', null],
    ]);
    expect(view.lines[3]?.screened).toBe(true);
    expect(view.asterisk).toMatchObject({
      metrics: 'ok',
      version: '22.8.2',
      uptimeSeconds: 60,
    });
    m.setMetrics(undefined);
    expect(m.snapshot().asterisk.metrics).toBe('failing');
    expect(m.snapshot().asterisk.version).toBe('22.8.2');
  });

  test('keeps only the newest recent calls', () => {
    const m = model();
    for (let i = 0; i < 5; i++) {
      const name = `PJSIP/vms-1994-0000002${i}`;
      walk(m, `12.${i}`, name, [[i, 'from-voipms', 's', 'NoOp']]);
      m.apply(
        ev('ChannelDestroyed', i + 1, {
          channel: channel(`12.${i}`, name),
          cause: 16,
        }),
      );
    }
    expect(m.snapshot().recent.map((c) => c.id)).toEqual([
      '12.4',
      '12.3',
      '12.2',
    ]);
  });

  test('tells subscribers about every change and reports the link', () => {
    const m = model();
    let changes = 0;
    const off = m.subscribe(() => changes++);
    m.setLink('connected');
    m.setLink('connected');
    m.setLink('disconnected', 'unauthorized');
    expect(changes).toBe(2);
    expect(m.snapshot().asterisk).toMatchObject({
      ari: 'disconnected',
      reason: 'unauthorized',
    });
    off();
    m.setLink('connected');
    expect(changes).toBe(2);
  });

  test('ignores events it does not use and channels it never saw end', () => {
    const m = model();
    m.apply(ev('DeviceStateChanged', 0));
    m.apply(
      ev('ChannelDestroyed', 0, {
        channel: channel('x', 'PJSIP/line1-000000ff'),
        cause: 16,
      }),
    );
    expect(m.snapshot()).toMatchObject({ calls: [], recent: [] });
  });
});
