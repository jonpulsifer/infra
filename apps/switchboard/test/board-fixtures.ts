import type { AriChannel, AriEvent } from '../src/board/ari-types.ts';
import type { LinePlan } from '../src/board/lines.ts';

export const PLAN: LinePlan[] = [
  {
    line: 'line1',
    trunk: 'vms-cathy',
    account: '168847_cathy',
    screened: false,
  },
  {
    line: 'line2',
    trunk: 'vms-recorded',
    account: '168847_recorded',
    screened: false,
  },
  {
    line: 'line3',
    trunk: 'vms-sandbox',
    account: '168847_sandbox',
    screened: false,
  },
  { line: 'line4', trunk: 'vms-1994', account: '168847_1994', screened: true },
];

const T0 = Date.parse('2026-09-26T12:00:00.000Z');

/** An ARI timestamp `seconds` after the fixture's start, in ARI's format. */
export function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString().replace('Z', '+0000');
}

export interface ChannelOpts {
  state?: string;
  context?: string;
  exten?: string;
  app?: string;
  data?: string;
  vars?: Record<string, string>;
  caller?: { name: string; number: string };
  created?: number;
}

export function channel(
  id: string,
  name: string,
  o: ChannelOpts = {},
): AriChannel {
  return {
    id,
    name,
    state: o.state ?? 'Ring',
    caller: o.caller ?? { name: '', number: '' },
    connected: { name: '', number: '' },
    dialplan: {
      context: o.context ?? '',
      exten: o.exten ?? '',
      priority: 1,
      app_name: o.app ?? '',
      app_data: o.data ?? '',
    },
    creationtime: at(o.created ?? 0),
    channelvars: {
      HANDSET: '',
      TRUNK: '',
      SCREEN: '',
      CONTACT: '',
      SINK: '',
      ...o.vars,
    },
  };
}

export function ev(
  type: string,
  seconds: number,
  rest: Partial<AriEvent> = {},
): AriEvent {
  return { type, timestamp: at(seconds), ...rest };
}
