import { describe, expect, test } from 'bun:test';
import type { Mouth } from '../src/mouth.ts';
import { ECHO_WINDOW_MS, NativeSpeech } from '../src/native.ts';
import type { ScribeEars } from '../src/scribe.ts';
import { capturingLog } from './fakes.ts';

const OWNER = '222222222222222222';
const GUEST = '555555555555555555';

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
  type Handlers = {
    onPartial(text: string): void;
    onCommitted(text: string): void;
    onEnd(reason: string): void;
  };
  const opened: {
    userId: string;
    handlers: Handlers;
    idleMs?: number;
    heard: number;
  }[] = [];
  const transcripts: [string, string, boolean][] = [];
  const bargeIns: number[] = [];
  const deaf: string[] = [];
  const log = capturingLog();
  const speech = new NativeSpeech({
    ownerId: OWNER,
    ears: (userId, h, idleMs) => {
      const entry = { userId, handlers: h, idleMs, heard: 0 };
      opened.push(entry);
      return {
        start: async () => {},
        hear: () => {
          entry.heard += 1;
        },
        // Scribe's ears end, and say so, on a stop too.
        stop: () => {
          earsStopped += 1;
          h.onEnd('stopped');
        },
      } as unknown as ScribeEars;
    },
    mouth: mouth as unknown as Mouth,
    log,
    now: () => now,
    onTranscript: (userId, text, final) =>
      transcripts.push([userId, text, final]),
    onBargeIn: (heardChars) => bargeIns.push(heardChars),
    onDeaf: (reason) => deaf.push(reason),
  });
  void speech.start();
  const ears = (userId = OWNER) => {
    const found = opened.find((o) => o.userId === userId);
    if (!found) throw new Error(`no ears for ${userId}`);
    return found.handlers;
  };
  return {
    speech,
    ears,
    said,
    announced,
    transcripts,
    bargeIns,
    deaf,
    log,
    opened,
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
      [OWNER, 'what is', false],
      [OWNER, 'what is the weather', true],
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
      [OWNER, 'wait', false],
      [OWNER, 'wait stop', false],
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
    // Ears that already ended are not stopped again.
    expect(h.stops()).toMatchObject({ earsStopped: 0, mouthStopped: 1 });
    expect(h.deaf).toEqual(['redial_cap']);
  });

  test('a clean stop is not deafness, and logs the counts once', () => {
    const h = harness();
    h.speech.say('The build passed.', true);
    h.setSpeaking(true);
    h.ears().onCommitted('stop');
    h.speech.stop();
    h.speech.stop();
    expect(h.deaf).toEqual([]);
    expect(h.stops()).toMatchObject({ earsStopped: 1, mouthStopped: 1 });
    expect(h.log.lines).toEqual([
      {
        level: 'info',
        msg: 'speech: stopped',
        bargeIns: 1,
        echoes: 0,
        others: 0,
      },
    ]);
  });

  test('someone else gets their own ears at their first frame, is passed through by id, and never barges in', () => {
    const h = harness();
    expect(h.opened.map((o) => o.userId)).toEqual([OWNER]);
    h.speech.hear(GUEST, Buffer.from([1]));
    h.speech.hear(GUEST, Buffer.from([1]));
    expect(h.opened.map((o) => [o.userId, o.idleMs])).toEqual([
      [OWNER, undefined],
      [GUEST, 60_000],
    ]);
    expect(h.opened[1]?.heard).toBe(2);
    h.speech.say('A long answer about ', false);
    h.setSpeaking(true);
    h.ears(GUEST).onPartial('hey');
    h.ears(GUEST).onCommitted('hey mate what is up');
    expect(h.bargeIns).toEqual([]);
    expect(h.transcripts).toEqual([
      [GUEST, 'hey', false],
      [GUEST, 'hey mate what is up', true],
    ]);
    // Their session going idle is not deafness, and the next frame reopens it.
    h.ears(GUEST).onEnd('idle');
    expect(h.deaf).toEqual([]);
    h.speech.hear(GUEST, Buffer.from([1]));
    expect(h.opened.filter((o) => o.userId === GUEST)).toHaveLength(2);
    expect(h.speech.counts.others).toBe(2);
    h.speech.stop();
    expect(h.stops().earsStopped).toBe(2);
  });
});
