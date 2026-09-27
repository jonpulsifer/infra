import type { AriChannel, AriEndpoint } from '../src/board/ari-types.ts';
import type { LinePlan } from '../src/board/lines.ts';
import type { BoardView, RecentCall } from '../src/board/model.ts';
import { BoardModel } from '../src/board/model.ts';

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

/** The ISO time the board reports for `seconds` after the fixture's start. */
export function iso(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
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
      TRAIL: '',
      EATEN: '',
      ...o.vars,
    },
  };
}

/**
 * A PBX as ARI lists it. A test puts channels where it wants them, bridges
 * and hangs them up, then polls: each poll hands the model the lists as they
 * stand, at a time on the fixture's clock.
 */
export class FakePbx {
  readonly ended: RecentCall[] = [];
  readonly model: BoardModel;
  private seconds = 0;
  private readonly channels = new Map<string, AriChannel>();
  private readonly bridges = new Map<string, string[]>();

  constructor(recentLimit = 3) {
    this.model = new BoardModel({
      plan: PLAN,
      recentLimit,
      now: () => T0 + this.seconds * 1000,
      onEnded: (call) => this.ended.push(call),
    });
  }

  put(id: string, name: string, o: ChannelOpts = {}): this {
    this.channels.set(id, channel(id, name, o));
    return this;
  }

  bridge(id: string, ...members: string[]): this {
    this.bridges.set(id, members);
    return this;
  }

  hangup(...ids: string[]): this {
    for (const id of ids) {
      this.channels.delete(id);
      for (const [bridge, members] of this.bridges) {
        const rest = members.filter((m) => m !== id);
        if (rest.length) this.bridges.set(bridge, rest);
        else this.bridges.delete(bridge);
      }
    }
    return this;
  }

  poll(seconds: number, endpoints: AriEndpoint[] = []): BoardView {
    this.seconds = seconds;
    this.model.load({
      channels: [...this.channels.values()],
      bridges: [...this.bridges].map(([id, channels]) => ({ id, channels })),
      endpoints,
    });
    return this.model.snapshot();
  }
}
