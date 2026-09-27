import { describe, expect, test } from 'bun:test';
import type { ChannelOpts } from './board-fixtures.ts';
import { FakePbx, iso } from './board-fixtures.ts';

const STRANGER = { name: 'WIRELESS CALLER', number: '6135550108' };

/** A screened caller on line 4 at a dialplan place, having logged `trail`. */
function line4(
  context: string,
  exten: string,
  app = '',
  data = '',
  trail = '',
  more: ChannelOpts = {},
): ChannelOpts {
  return {
    state: 'Up',
    context,
    exten,
    app,
    data,
    caller: STRANGER,
    ...more,
    vars: { HANDSET: 'line4', SCREEN: 'yes', TRAIL: trail, ...more.vars },
  };
}

const stage = (pbx: FakePbx, seconds: number) =>
  pbx.poll(seconds).calls[0]?.stage.label;

describe('the board model', () => {
  test('follows a screened stranger through the prompt, into a sink and into recent', () => {
    const pbx = new FakePbx();
    const trunk = 'PJSIP/vms-1994-00000001';
    pbx.put('1.1', trunk, line4('from-voipms', '9028261994', 'Goto', 's,1'));
    expect(stage(pbx, 0)).toBe('arrived');
    // The event logger is a subroutine and leaves the stage where it was.
    pbx.put('1.1', trunk, line4('pbx-event', 's', 'Log', '', 'inbound'));
    expect(stage(pbx, 1)).toBe('arrived');
    pbx.put(
      '1.1',
      trunk,
      line4(
        'from-voipms',
        's',
        'Read',
        'DIGIT,/var/lib/pbx-sounds/captcha-greeting,1,,1,6',
        'inbound',
      ),
    );
    expect(stage(pbx, 2)).toBe('press-5 prompt');
    pbx.put(
      '1.1',
      trunk,
      line4(
        'from-voipms',
        's',
        'Read',
        'DIGIT,/var/lib/pbx-sounds/captcha-retry,1,,1,6',
        'inbound',
      ),
    );
    expect(stage(pbx, 8)).toBe('press-5 prompt, second try');
    pbx.put(
      '1.1',
      trunk,
      line4('spam', 's', 'Set', 'SINK=lenny', 'inbound screened'),
    );
    expect(stage(pbx, 14)).toBe('into the sinks');
    pbx.put(
      '1.1',
      trunk,
      line4(
        'spam',
        'lenny',
        'Playback',
        '/var/lib/pbx-sounds/lenny-hello',
        'inbound screened lenny',
      ),
    );
    expect(pbx.poll(15).calls[0]).toMatchObject({
      direction: 'inbound',
      line: 'line4',
      trunk: 'vms-1994',
      caller: STRANGER,
      verdict: 'screened',
      trail: ['inbound', 'screened', 'lenny'],
      stage: { key: 'held', label: 'held: Robo-Lenny' },
    });
    // So is the hangup handler.
    pbx.put(
      '1.1',
      trunk,
      line4('spam-held', 's', 'Log', '', 'inbound screened lenny held'),
    );
    expect(stage(pbx, 75)).toBe('held: Robo-Lenny');
    const view = pbx.hangup('1.1').poll(76);
    expect(view.calls).toHaveLength(0);
    expect(view.recent[0]).toMatchObject({
      verdict: 'screened',
      trail: ['inbound', 'screened', 'lenny', 'held'],
      lastStage: 'held: Robo-Lenny',
      startedAt: iso(0),
      endedAt: iso(75),
      seconds: 75,
      talkedSeconds: 0,
    });
    expect(pbx.ended).toHaveLength(1);
  });

  test('a caller who presses 5 rings the desk and then talks on the line', () => {
    const pbx = new FakePbx();
    const trunk = 'PJSIP/vms-1994-00000002';
    const desk = 'PJSIP/line4-00000003';
    const human = line4(
      'from-voipms',
      'human',
      'Dial',
      'PJSIP/line4,25,mb(handset-leg^s^1(Human))',
      'inbound captcha-pass',
    );
    pbx.put('2.1', trunk, human);
    // Dial's pre-dial handler runs on the desk's leg before Dial marks it.
    pbx.put('2.2', desk, {
      context: 'handset-leg',
      exten: 's',
      app: 'ExecIf',
      created: 3,
    });
    let view = pbx.poll(3);
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]).toMatchObject({
      verdict: 'pressed 5',
      stage: { key: 'ringing', label: 'pressed 5 → ringing desk' },
    });
    pbx.put('2.2', desk, {
      state: 'Up',
      app: 'AppDial',
      data: '(Outgoing Line)',
      created: 3,
    });
    view = pbx.bridge('b1', '2.2', '2.1').poll(9);
    expect(view.calls[0]).toMatchObject({
      stage: { key: 'talking', label: 'talking on line4' },
      talkingSince: iso(9),
    });
    expect(view.lines.find((l) => l.line === 'line4')?.calls).toBe(1);
    pbx.poll(70);
    view = pbx.hangup('2.2', '2.1').poll(71);
    expect(view.recent).toHaveLength(1);
    expect(view.recent[0]).toMatchObject({
      lastStage: 'talked with line4',
      seconds: 70,
      talkedSeconds: 61,
    });
  });

  test('a contact rings through with its verdict', () => {
    const pbx = new FakePbx();
    pbx.put(
      '3.1',
      'PJSIP/vms-1994-00000004',
      line4(
        'from-voipms',
        'ring',
        'Dial',
        'PJSIP/line4,25,b(handset-leg^s^1(Friend))',
        'inbound contact',
        { vars: { CONTACT: 'Mum' } },
      ),
    );
    expect(pbx.poll(0).calls[0]).toMatchObject({
      verdict: 'contact',
      stage: { label: 'contact → ringing desk' },
    });
  });

  test('an unscreened line and a 911 callback ring unanswered', () => {
    const pbx = new FakePbx();
    pbx.put('4.1', 'PJSIP/vms-cathy-00000005', {
      context: 'from-voipms',
      exten: 'ring',
      app: 'Dial',
      vars: { HANDSET: 'line1', TRAIL: 'inbound' },
    });
    pbx.put(
      '4.2',
      'PJSIP/vms-1994-00000006',
      line4('from-voipms', 'ring', 'Dial', '', 'inbound', { created: 1 }),
    );
    const [open, callback] = pbx.poll(1).calls;
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
    const pbx = new FakePbx();
    pbx.put(
      '5.1',
      'PJSIP/vms-1994-00000007',
      line4('from-voipms', 'busy', 'Hangup', '17', 'inbound'),
    );
    pbx.put(
      '5.2',
      'PJSIP/vms-1994-00000008',
      line4('spam', 'full', 'Playback', '', 'inbound screened troll-miss'),
    );
    const [busy, full] = pbx.poll(0).calls;
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
    const pbx = new FakePbx();
    const line = 'PJSIP/line1-00000009';
    const call: ChannelOpts = {
      context: 'from-handset',
      exten: '6135550123',
      app: 'Dial',
      data: 'PJSIP/6135550123@vms-cathy,60',
      vars: { TRUNK: 'vms-cathy' },
      caller: { name: 'Office', number: 'line1' },
    };
    pbx.put('6.1', line, call);
    pbx.put('6.2', 'PJSIP/vms-cathy-0000000a', { app: 'AppDial' });
    expect(pbx.poll(0).calls).toEqual([
      expect.objectContaining({
        direction: 'handset',
        line: 'line1',
        trunk: 'vms-cathy',
        dialled: '6135550123',
        stage: {
          key: 'outbound',
          label: 'outbound to 6135550123 via vms-cathy',
        },
      }),
    ]);
    pbx.bridge('b2', '6.2', '6.1');
    expect(stage(pbx, 5)).toBe('talking to 6135550123 via vms-cathy');
  });

  test('knows the leg a Dial rings by the target it names', () => {
    const pbx = new FakePbx();
    // A screened caller dialled straight at the agent from the prompt.
    pbx.put(
      '16.1',
      'PJSIP/vms-1994-00000050',
      line4('from-voipms', 's', 'Dial', 'PJSIP/19025550100@elevenlabs,60'),
    );
    pbx.put('16.2', 'PJSIP/elevenlabs-00000051', { app: 'AppDial' });
    // Another call's leg to the desk is not this Dial's.
    pbx.put('16.3', 'PJSIP/line1-00000052', { app: 'AppDial' });
    expect(pbx.poll(0).calls.map((c) => [c.id, c.stage.label])).toEqual([
      ['16.1', 'with Earl'],
    ]);
  });

  test('handset codes read as toys, the sinks included', () => {
    const pbx = new FakePbx();
    pbx.put('7.1', 'PJSIP/line2-0000000b', {
      context: 'toybox',
      exten: 'echo',
      app: 'Echo',
      vars: { TRUNK: 'vms-recorded' },
    });
    pbx.put('7.2', 'PJSIP/line3-0000000c', {
      context: 'spam',
      exten: 'lenny',
      app: 'Playback',
      vars: { TRUNK: 'vms-sandbox' },
      created: 1,
    });
    expect(pbx.poll(1).calls.map((c) => c.stage.label)).toEqual([
      'toy: echo',
      'toy: Robo-Lenny',
    ]);
  });

  test('the troll line reads as Earl, and a context it does not know by name', () => {
    const pbx = new FakePbx();
    pbx.put('8.1', 'PJSIP/vms-1994-0000000d', line4('agent', 's', 'Dial'));
    pbx.put(
      '8.2',
      'PJSIP/vms-1994-0000000e',
      line4('party-line', 's', 'Playback', '', '', { created: 1 }),
    );
    expect(pbx.poll(1).calls.map((c) => c.stage)).toEqual([
      { key: 'agent', label: 'with Earl' },
      { key: 'other', label: 'in party-line' },
    ]);
  });

  test('a screened caller talks with Earl through the hangup handler and into recent', () => {
    const pbx = new FakePbx();
    const trunk = 'PJSIP/vms-1994-00000040';
    const agent = 'PJSIP/elevenlabs-00000041';
    const dial = line4(
      'agent',
      'dial',
      'Dial',
      'PJSIP/19025550100@elevenlabs,60,b(agent-leg^s^1(troll^14.1^6135550108))S(600)',
      'inbound screened troll',
    );
    pbx.put('14.1', trunk, dial);
    pbx.put('14.2', agent, {
      context: 'agent-leg',
      exten: 's',
      app: 'Set',
      created: 14,
    });
    let view = pbx.poll(14);
    expect(view.calls).toHaveLength(1);
    expect(view.calls[0]?.stage.label).toBe('with Earl');
    pbx.put('14.2', agent, { state: 'Up', app: 'AppDial', created: 14 });
    view = pbx.bridge('b3', '14.2', '14.1').poll(16);
    expect(view.calls[0]).toMatchObject({
      verdict: 'screened',
      trail: ['inbound', 'screened', 'troll'],
      stage: { key: 'agent', label: 'with Earl' },
    });
    // agent.conf's hangup handler logs the call without moving it.
    pbx.hangup('14.2');
    pbx.put(
      '14.1',
      trunk,
      line4('agent-held', 's', 'Log', '', 'inbound screened troll held'),
    );
    expect(stage(pbx, 76)).toBe('with Earl');
    view = pbx.hangup('14.1').poll(77);
    expect(view.recent[0]).toMatchObject({
      lastStage: 'talked with Earl',
      trail: ['inbound', 'screened', 'troll', 'held'],
      talkedSeconds: 60,
    });
  });

  test('a caller Earl does not take falls back to the sinks', () => {
    const pbx = new FakePbx();
    pbx.put(
      '15.1',
      'PJSIP/vms-1994-00000042',
      line4('spam', 'queue', 'Playback', '', 'inbound screened troll-miss'),
    );
    expect(pbx.poll(1).calls[0]).toMatchObject({
      verdict: 'screened',
      trail: ['inbound', 'screened', 'troll-miss'],
      stage: { key: 'held', label: 'held: Endless Queue' },
    });
  });

  test('a verdict holds after the place that gave it is gone', () => {
    const pbx = new FakePbx();
    const name = 'PJSIP/vms-1994-0000000f';
    pbx.put('9.1', name, line4('from-voipms', 'busy', 'NoOp', '', 'inbound'));
    pbx.poll(0);
    pbx.put('9.1', name, line4('from-voipms', 'h', 'NoOp', '', 'inbound'));
    expect(pbx.poll(1).calls[0]?.verdict).toBe('refused (busy)');
  });

  test('counts the callers the sinks have eaten from the global', () => {
    const pbx = new FakePbx();
    expect(pbx.poll(0).eaten).toBeNull();
    pbx.put('10.1', 'PJSIP/vms-1994-00000010', {
      context: 'spam',
      exten: 'queue',
      vars: { EATEN: '7' },
    });
    // Its last step was before the seventh caller was eaten.
    pbx.put('10.2', 'PJSIP/vms-1994-00000011', {
      context: 'spam',
      exten: 'lenny',
      vars: { EATEN: '6' },
    });
    expect(pbx.poll(1).eaten).toBe(7);
    pbx.hangup('10.1', '10.2');
    expect(pbx.poll(2).eaten).toBe(7);
    pbx.model.setLink('disconnected', 'unreachable');
    expect(pbx.model.snapshot().eaten).toBeNull();
  });

  test('a channel the lists stop naming ends as of the last poll that named it', () => {
    const pbx = new FakePbx();
    pbx.put('11.1', 'PJSIP/vms-1994-00000012', line4('spam', 'queue'));
    pbx.poll(40);
    // The PBX was unreachable in between, and the call ended unseen.
    const view = pbx.hangup('11.1').poll(300);
    expect(view.calls).toHaveLength(0);
    expect(view.recent[0]).toMatchObject({ id: '11.1', seconds: 40 });
  });

  test('a bridge that names a channel the list lacks places what it can', () => {
    const pbx = new FakePbx();
    pbx.put(
      '12.1',
      'PJSIP/vms-cathy-00000013',
      line4('from-voipms', 'ring', 'Dial', 'PJSIP/line1,25', 'inbound', {
        vars: { HANDSET: 'line1', SCREEN: '' },
      }),
    );
    pbx.bridge('b4', '12.1', 'not-listed-yet');
    expect(pbx.poll(0).calls[0]).toMatchObject({
      stage: { label: 'ringing desk (unscreened line)' },
      talkingSince: null,
    });
  });

  test('shows each line with its handset, trunk registration and use', () => {
    const pbx = new FakePbx();
    pbx.model.setMetrics({
      registrations: {
        '168847_cathy': 'registered',
        '168847_sandbox': 'rejected',
      },
      endpoints: { line1: 'online', line2: 'offline' },
      version: '22.8.2',
      uptimeSeconds: 60,
    });
    // ARI's endpoint list is newer than the scrape.
    const view = pbx.poll(0, [
      { technology: 'PJSIP', resource: 'line2', state: 'online' },
    ]);
    expect(view.lines.map((l) => [l.line, l.handset, l.registration])).toEqual([
      ['line1', 'online', 'registered'],
      ['line2', 'online', 'unknown'],
      ['line3', 'unknown', 'rejected'],
      ['line4', 'unknown', 'unknown'],
    ]);
    expect(view.lines[3]?.screened).toBe(true);
    expect(view.asterisk).toMatchObject({
      metrics: 'ok',
      version: '22.8.2',
      uptimeSeconds: 60,
    });
    pbx.model.setMetrics(undefined);
    expect(pbx.model.snapshot().asterisk.metrics).toBe('failing');
    expect(pbx.model.snapshot().asterisk.version).toBe('22.8.2');
  });

  test('keeps only the newest recent calls', () => {
    const pbx = new FakePbx();
    for (let i = 0; i < 5; i++) {
      pbx.put(
        `13.${i}`,
        `PJSIP/vms-1994-0000002${i}`,
        line4('from-voipms', 's', '', '', '', { created: i * 2 }),
      );
      pbx.poll(i * 2);
      pbx.hangup(`13.${i}`).poll(i * 2 + 1);
    }
    expect(pbx.model.snapshot().recent.map((c) => c.id)).toEqual([
      '13.4',
      '13.3',
      '13.2',
    ]);
  });

  test('tells subscribers about each change, and not about a poll that changes nothing', () => {
    const pbx = new FakePbx();
    let changes = 0;
    const off = pbx.model.subscribe(() => changes++);
    pbx.model.setLink('connected');
    pbx.model.setLink('connected');
    pbx.model.setLink('disconnected', 'unauthorized');
    expect(changes).toBe(2);
    expect(pbx.model.snapshot().asterisk).toMatchObject({
      ari: 'disconnected',
      reason: 'unauthorized',
    });
    pbx.put('17.1', 'PJSIP/vms-1994-00000060', line4('spam', 'queue'));
    pbx.poll(1);
    pbx.poll(2);
    pbx.poll(3);
    expect(changes).toBe(3);
    off();
    pbx.model.setLink('connected');
    expect(changes).toBe(3);
  });
});
