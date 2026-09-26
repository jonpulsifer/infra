import { describe, expect, test } from 'bun:test';
import type { Direction, StageInput } from '../src/board/stage.ts';
import { stageOf } from '../src/board/stage.ts';

function input(
  direction: Direction,
  context: string,
  exten: string,
  more: Partial<StageInput> & { app?: string; appData?: string } = {},
): StageInput {
  return {
    direction,
    place: { context, exten, app: more.app ?? '', appData: more.appData ?? '' },
    vars: more.vars ?? {},
    trunk: more.trunk ?? null,
    bridgedTo: more.bridgedTo ?? null,
    dialling: more.dialling ?? null,
  };
}

describe('the IVR stage of a call', () => {
  const cases: [string, StageInput, string, string][] = [
    [
      'a call that just arrived',
      input('inbound', 'from-voipms', '9028261994'),
      'arrived',
      'arrived',
    ],
    [
      'the first prompt',
      input('inbound', 'from-voipms', 's', {
        app: 'Read',
        appData: 'DIGIT,/var/lib/pbx-sounds/captcha-greeting,1,,1,6',
      }),
      'prompt',
      'press-5 prompt',
    ],
    [
      'the second prompt',
      input('inbound', 'from-voipms', 's', {
        app: 'Read',
        appData: 'DIGIT,/var/lib/pbx-sounds/captcha-retry,1,,1,6',
      }),
      'prompt',
      'press-5 prompt, second try',
    ],
    [
      'pressed 5',
      input('inbound', 'from-voipms', 'human', { app: 'Dial' }),
      'ringing',
      'pressed 5 → ringing desk',
    ],
    [
      'a contact',
      input('inbound', 'from-voipms', 'contact'),
      'ringing',
      'contact → ringing desk',
    ],
    [
      'a contact at the desk',
      input('inbound', 'from-voipms', 'ring', {
        vars: { CONTACT: 'Mum', SCREEN: 'yes' },
      }),
      'ringing',
      'contact → ringing desk',
    ],
    [
      'an unscreened line',
      input('inbound', 'from-voipms', 'ring'),
      'ringing',
      'ringing desk (unscreened line)',
    ],
    [
      'a 911 callback',
      input('inbound', 'from-voipms', 'ring', { vars: { SCREEN: 'yes' } }),
      'ringing',
      'ringing desk (911 callback)',
    ],
    [
      'answered at the desk',
      input('inbound', 'from-voipms', 'human', { bridgedTo: 'line4' }),
      'talking',
      'talking on line4',
    ],
    [
      'the Endless Queue',
      input('inbound', 'spam', 'queue'),
      'held',
      'held: Endless Queue',
    ],
    [
      'Robo-Lenny',
      input('inbound', 'spam', 'lenny'),
      'held',
      'held: Robo-Lenny',
    ],
    [
      'on the way to a sink',
      input('inbound', 'spam', 's'),
      'held',
      'into the sinks',
    ],
    [
      'the sinks full',
      input('inbound', 'spam', 'full'),
      'refused',
      'refused (full)',
    ],
    [
      'a line at its screening cap',
      input('inbound', 'from-voipms', 'busy'),
      'refused',
      'refused (busy)',
    ],
    ['the troll agent', input('inbound', 'agent', 's'), 'agent', 'with Earl'],
    [
      'dialling the troll agent',
      input('inbound', 'from-voipms', 's', { dialling: 'elevenlabs' }),
      'agent',
      'with Earl',
    ],
    [
      'talking to the troll agent',
      input('handset', 'agent', 's', { bridgedTo: 'elevenlabs' }),
      'agent',
      'with Earl',
    ],
    ['a toy', input('handset', 'toybox', 'clock'), 'toy', 'toy: clock'],
    [
      'a sink from the handset',
      input('handset', 'spam', 'queue'),
      'toy',
      'toy: Endless Queue',
    ],
    [
      'dialling out',
      input('handset', 'from-handset', '6135550123', { trunk: 'vms-cathy' }),
      'outbound',
      'outbound to 6135550123 via vms-cathy',
    ],
    [
      'talking out',
      input('handset', 'from-handset', '6135550123', {
        trunk: 'vms-cathy',
        bridgedTo: 'vms-cathy',
      }),
      'talking',
      'talking to 6135550123 via vms-cathy',
    ],
    [
      'a context it does not know',
      input('other', 'party-line', 's'),
      'other',
      'in party-line',
    ],
  ];
  for (const [name, given, key, label] of cases) {
    test(name, () => {
      expect(stageOf(given)).toEqual({ key: key as never, label });
    });
  }
});
