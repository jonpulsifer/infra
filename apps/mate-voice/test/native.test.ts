import { describe, expect, test } from 'bun:test';
import type { Mouth } from '../src/mouth.ts';
import { ECHO_WINDOW_MS, NativeSpeech } from '../src/native.ts';
import type { ScribeEars } from '../src/scribe.ts';
import { capturingLog } from './fakes.ts';

function harness() {
  let now = 1_000;
  const said: [string, boolean][] = [];
  const announced: string[] = [];
  let speaking = false;
  let hushes = 0;
  let earsStopped = 0;
  let mouthStopped = 0;
  const mouth = {
    say: async (text: string, final: boolean) => {
      said.push([text, final]);
    },
    announce: async (text: string) => {
      announced.push(text);
    },
    hush: () => {
      hushes += 1;
      speaking = false;
    },
    stop: () => {
      mouthStopped += 1;
    },
    get speaking() {
      return speaking;
    },
    heardChars: 7,
  };
  let handlers: {
    onPartial(text: string): void;
    onCommitted(text: string): void;
    onEnd(reason: string): void;
  } | null = null;
  const transcripts: [string, boolean][] = [];
  const bargeIns: number[] = [];
  const deaf: string[] = [];
  const speech = new NativeSpeech({
    ears: (h) => {
      handlers = h;
      return {
        start: async () => {},
        hear: () => {},
        stop: () => {
          earsStopped += 1;
        },
      } as unknown as ScribeEars;
    },
    mouth: mouth as unknown as Mouth,
    log: capturingLog(),
    now: () => now,
    onTranscript: (text, final) => transcripts.push([text, final]),
    onBargeIn: (heardChars) => bargeIns.push(heardChars),
    onDeaf: (reason) => deaf.push(reason),
  });
  const ears = () => {
    if (!handlers) throw new Error('no ears');
    return handlers;
  };
  return {
    speech,
    ears,
    said,
    announced,
    transcripts,
    bargeIns,
    deaf,
    setSpeaking: (value: boolean) => {
      speaking = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    stops: () => ({ hushes, earsStopped, mouthStopped }),
  };
}

describe('native speech', () => {
  test('passes the owner through and voices mate', () => {
    const h = harness();
    h.ears().onPartial('what is');
    h.ears().onCommitted('what is the weather');
    expect(h.transcripts).toEqual([
      ['what is', false],
      ['what is the weather', true],
    ]);
    h.speech.say('Sunny, ', false);
    h.speech.say('twelve degrees.', true);
    h.speech.announce('The build passed.');
    expect(h.said).toEqual([
      ['Sunny, ', false],
      ['twelve degrees.', true],
    ]);
    expect(h.announced).toEqual(['The build passed.']);
  });

  test('the owner speaking over mate hushes the mouth once per utterance and tells mate how much was voiced', () => {
    const h = harness();
    h.speech.say('A long answer about ', false);
    h.setSpeaking(true);
    h.ears().onPartial('wait');
    h.ears().onPartial('wait stop');
    expect(h.bargeIns).toEqual([7]);
    expect(h.stops().hushes).toBe(1);
    expect(h.transcripts).toEqual([
      ['wait', false],
      ['wait stop', false],
    ]);
    h.ears().onCommitted('wait stop');
    h.setSpeaking(true);
    h.ears().onPartial('and');
    expect(h.bargeIns).toEqual([7, 7]);
  });

  test("mate's own recent words coming back are echo, not a turn", () => {
    const h = harness();
    h.speech.say('The build passed on the second try.', true);
    h.setSpeaking(true);
    h.ears().onPartial('the build passed on the');
    h.ears().onCommitted('the build passed on the second try');
    expect(h.transcripts).toEqual([]);
    expect(h.bargeIns).toEqual([]);
    expect(h.speech.counts.echoes).toBe(1);
    h.ears().onCommitted('passed');
    expect(h.transcripts).toEqual([]);
    h.ears().onCommitted('did the build pass or fail today');
    expect(h.transcripts).toHaveLength(1);
    h.advance(ECHO_WINDOW_MS + 1);
    h.setSpeaking(false);
    h.ears().onCommitted('the build passed on the second try');
    expect(h.transcripts).toHaveLength(2);
  });

  test('stop ends both halves; deaf ears are reported once', () => {
    const h = harness();
    h.ears().onEnd('redial_cap');
    expect(h.deaf).toEqual(['redial_cap']);
    h.speech.stop();
    expect(h.stops()).toMatchObject({ earsStopped: 1, mouthStopped: 1 });
  });
});
