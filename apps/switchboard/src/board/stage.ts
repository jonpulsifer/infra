/** Who started a call: a voip.ms trunk, the desk phone, or neither. */
export type Direction = 'inbound' | 'handset' | 'other';

export type StageKey =
  | 'arrived'
  | 'prompt'
  | 'ringing'
  | 'talking'
  | 'held'
  | 'agent'
  | 'toy'
  | 'outbound'
  | 'refused'
  | 'other';

export interface Stage {
  readonly key: StageKey;
  readonly label: string;
}

/** Where a channel is in the dialplan, outside any subroutine. */
export interface Place {
  readonly context: string;
  readonly exten: string;
  readonly app: string;
  readonly appData: string;
}

export interface StageInput {
  readonly direction: Direction;
  readonly place: Place;
  readonly vars: Readonly<Record<string, string>>;
  readonly trunk: string | null;
  /** The endpoint of the channel sharing the call's bridge, if any. */
  readonly bridgedTo: string | null;
  /** The endpoint the call is dialling, if a Dial is in progress. */
  readonly dialling: string | null;
}

const LINE = /^line\d+$/;
/** The PJSIP endpoint of the ElevenLabs trunk in pjsip.conf. */
export const AGENT_ENDPOINT = 'elevenlabs';
/** The troll agent's name on the phone. */
export const AGENT_NAME = 'Earl';
// The ElevenLabs troll line's contexts, from agent.conf.
const AGENT_CONTEXTS = new Set(['agent', 'from-elevenlabs']);
const SINKS: Record<string, string> = {
  queue: 'Endless Queue',
  lenny: 'Robo-Lenny',
};

const stage = (key: StageKey, label: string): Stage => ({ key, label });

function via(trunk: string | null): string {
  return trunk ? ` via ${trunk}` : '';
}

function inbound(input: StageInput): Stage {
  const { exten, app, appData } = input.place;
  switch (exten) {
    case 'busy':
      return stage('refused', 'refused (busy)');
    case 'human':
      return stage('ringing', 'pressed 5 → ringing desk');
    case 'contact':
      return stage('ringing', 'contact → ringing desk');
    case 'ring':
      if (input.vars.CONTACT) return stage('ringing', 'contact → ringing desk');
      if (input.vars.SCREEN !== 'yes') {
        return stage('ringing', 'ringing desk (unscreened line)');
      }
      return stage('ringing', 'ringing desk (911 callback)');
    case 's':
      if (app === 'Read') {
        return stage(
          'prompt',
          appData.includes('captcha-retry')
            ? 'press-5 prompt, second try'
            : 'press-5 prompt',
        );
      }
      return stage('arrived', 'arrived');
    default:
      return stage('arrived', 'arrived');
  }
}

/**
 * The IVR stage of one call, from where its first channel is in the folly
 * dialplan (clusters/folly/apps/pbx/config/) and what it is bridged to or
 * dialling. A context this does not know reads as `in <context>`, so a new
 * feature shows up before the board learns its name.
 */
export function stageOf(input: StageInput): Stage {
  const { direction, place, bridgedTo, dialling } = input;
  const dialled = place.exten;

  if (bridgedTo === AGENT_ENDPOINT || dialling === AGENT_ENDPOINT) {
    return stage('agent', `with ${AGENT_NAME}`);
  }
  if (bridgedTo) {
    if (direction === 'handset') {
      return stage('talking', `talking to ${dialled}${via(input.trunk)}`);
    }
    if (LINE.test(bridgedTo))
      return stage('talking', `talking on ${bridgedTo}`);
    return stage('talking', 'talking');
  }
  if (AGENT_CONTEXTS.has(place.context))
    return stage('agent', `with ${AGENT_NAME}`);

  switch (place.context) {
    case 'from-voipms':
      return inbound(input);
    case 'spam': {
      if (place.exten === 'full') return stage('refused', 'refused (full)');
      const sink = SINKS[place.exten];
      if (direction === 'handset') {
        return stage('toy', `toy: ${sink ?? place.exten}`);
      }
      return sink
        ? stage('held', `held: ${sink}`)
        : stage('held', 'into the sinks');
    }
    case 'toybox':
      return stage('toy', `toy: ${place.exten}`);
    case 'from-handset':
      return stage('outbound', `outbound to ${dialled}${via(input.trunk)}`);
    case '':
      return stage('arrived', 'arrived');
    default:
      return stage('other', `in ${place.context}`);
  }
}
