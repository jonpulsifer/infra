import type {
  AriBridge,
  AriChannel,
  AriEndpoint,
  AriEvent,
} from './ari-types.ts';
import { parseAriTime } from './ari-types.ts';
import type { LinePlan } from './lines.ts';
import type { EndpointState, PbxMetrics, Registration } from './metrics.ts';
import {
  AGENT_ENDPOINT,
  AGENT_NAME,
  type Direction,
  type Place,
  type Stage,
  stageOf,
} from './stage.ts';

/**
 * The channel variables the board reads. ari.conf's `channelvars` names the
 * same list, so each channel event carries their current values.
 */
export const TRACKED_VARS = [
  'HANDSET',
  'TRUNK',
  'SCREEN',
  'CONTACT',
  'SINK',
] as const;

// Dialplan the call passes through without moving: the event logger, Dial's
// pre-dial handlers, the sinks' and the agent's hangup handlers, and each
// context's `h`.
const SUBROUTINES = new Set([
  'pbx-event',
  'handset-leg',
  'agent-leg',
  'spam-held',
  'agent-held',
]);

// events.conf's kinds that decide how the PBX treated a caller.
const VERDICTS: Record<string, string> = {
  contact: 'contact',
  'captcha-pass': 'pressed 5',
  screened: 'screened',
};

const PBX_EVENT = /^pbx-event,s,1\(([a-z0-9-]+)/;

export interface Party {
  readonly name: string;
  readonly number: string;
}

export interface CallView {
  readonly id: string;
  readonly direction: Direction;
  readonly line: string | null;
  readonly trunk: string | null;
  readonly caller: Party;
  /** What the desk phone dialled, on a handset call. */
  readonly dialled: string | null;
  readonly stage: Stage;
  readonly verdict: string | null;
  /** events.conf kinds this call has logged, in order. */
  readonly trail: readonly string[];
  /** The Asterisk channel state of the call's first channel. */
  readonly state: string;
  readonly startedAt: string;
  readonly talkingSince: string | null;
}

export interface RecentCall {
  readonly id: string;
  readonly direction: Direction;
  readonly line: string | null;
  readonly trunk: string | null;
  readonly caller: Party;
  readonly dialled: string | null;
  readonly verdict: string | null;
  readonly trail: readonly string[];
  readonly lastStage: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly seconds: number;
  readonly talkedSeconds: number;
  readonly cause: number | null;
  readonly causeText: string | null;
}

export interface LineView {
  readonly line: string;
  readonly trunk: string | null;
  readonly account: string | null;
  readonly screened: boolean;
  readonly handset: EndpointState;
  readonly handsetRttMs: number | null;
  readonly registration: Registration | 'unknown';
  readonly calls: number;
}

export type AriLink = 'connecting' | 'connected' | 'disconnected';

export interface AsteriskView {
  readonly ari: AriLink;
  /** Why the last attempt failed: `unauthorized`, `unreachable` or `closed`. */
  readonly reason: string | null;
  readonly since: string;
  readonly metrics: 'ok' | 'failing' | 'unknown';
  readonly version: string | null;
  readonly uptimeSeconds: number | null;
}

export interface BoardView {
  readonly now: string;
  readonly asterisk: AsteriskView;
  readonly lines: readonly LineView[];
  readonly calls: readonly CallView[];
  readonly recent: readonly RecentCall[];
  /** GLOBAL(EATEN): callers the sinks admitted since the PBX started. */
  readonly eaten: number | null;
}

interface Leg {
  readonly id: string;
  /** When the board first heard of it, by the board's clock. */
  readonly seenAt: number;
  name: string;
  endpoint: string | null;
  state: string;
  caller: Party;
  createdAt: number;
  place: Place;
  vars: Record<string, string>;
  parent?: string;
  /** Dial's outgoing leg, known by its app even when the Dial was missed. */
  dialled: boolean;
  bridge?: string;
  bridgedAt?: number;
  talkedWith?: string;
  verdict?: string;
  trail: string[];
}

export interface ModelOptions {
  readonly plan: readonly LinePlan[];
  readonly recentLimit: number;
  readonly now?: () => number;
  /** Called once for each call that ends. */
  readonly onEnded?: (call: RecentCall) => void;
}

const EMPTY_PLACE: Place = { context: '', exten: '', app: '', appData: '' };

// How long a destroyed channel's id is remembered, so a channel list fetched
// just before it ended cannot bring it back.
const GONE_MS = 120_000;

/** PJSIP/line4-0000002a names endpoint line4. */
function endpointOf(name: string): string | null {
  const match = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(name);
  return match ? (match[1] as string) : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * The PBX as the board shows it: every channel ARI reports, folded into calls
 * keyed by the channel that started them, plus the four lines and the calls
 * that ended while the board watched. It does no I/O; the ARI client feeds it
 * events and the server reads snapshots.
 */
export class BoardModel {
  private readonly legs = new Map<string, Leg>();
  private readonly bridges = new Map<string, Set<string>>();
  private readonly ariEndpoints = new Map<string, EndpointState>();
  private readonly contactRtt = new Map<string, number>();
  private readonly gone = new Map<string, number>();
  private recent: RecentCall[] = [];
  private metrics: PbxMetrics | undefined;
  private metricsState: AsteriskView['metrics'] = 'unknown';
  private link: AriLink = 'connecting';
  private linkReason: string | null = null;
  private linkSince: number;
  private eaten: number | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly plan: readonly LinePlan[];
  private readonly trunkLine = new Map<string, LinePlan>();
  private readonly lineByName = new Map<string, LinePlan>();
  private readonly now: () => number;

  constructor(private readonly opts: ModelOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.plan = opts.plan;
    for (const plan of opts.plan) {
      this.lineByName.set(plan.line, plan);
      if (plan.trunk) this.trunkLine.set(plan.trunk, plan);
    }
    this.linkSince = this.now();
  }

  /** The model's clock, so a caller can stamp a request with it. */
  clock(): number {
    return this.now();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  setLink(link: AriLink, reason: string | null = null): void {
    if (link === this.link && reason === this.linkReason) return;
    this.link = link;
    this.linkReason = reason;
    this.linkSince = this.now();
    this.changed();
  }

  setMetrics(metrics: PbxMetrics | undefined): void {
    if (metrics) this.metrics = metrics;
    this.metricsState = metrics ? 'ok' : 'failing';
    this.changed();
  }

  /**
   * Replaces every channel and bridge with ARI's current lists, as after a
   * (re)connect or a periodic resync. `since` is when the lists were asked
   * for: a channel the board first heard of before then, and ARI does not
   * list, ended unseen and goes to recent with no cause. One heard of since
   * started after the lists were read, and one destroyed since ended after,
   * so the lists do not speak for either.
   */
  load(
    state: {
      channels: readonly AriChannel[];
      bridges: readonly AriBridge[];
      endpoints?: readonly AriEndpoint[];
    },
    since = this.now(),
  ): void {
    const live = new Set(state.channels.map((c) => c.id));
    for (const leg of [...this.legs.values()]) {
      if (!live.has(leg.id) && leg.seenAt < since) {
        this.end(leg, this.now(), null, null);
      }
    }
    for (const channel of state.channels) {
      if (!this.gone.has(channel.id)) this.upsert(channel);
    }
    this.bridges.clear();
    for (const leg of this.legs.values()) leg.bridge = undefined;
    for (const bridge of state.bridges) this.setBridge(bridge);
    for (const endpoint of state.endpoints ?? []) this.setEndpoint(endpoint);
    this.changed();
  }

  apply(event: AriEvent): void {
    const at = parseAriTime(event.timestamp) ?? this.now();
    switch (event.type) {
      case 'ChannelCreated':
      case 'ChannelStateChange':
      case 'ChannelDialplan':
      case 'ChannelCallerId':
      case 'ChannelConnectedLine':
      case 'ChannelHangupRequest':
        if (event.channel) this.upsert(event.channel, at);
        break;
      case 'ChannelVarset':
        this.varset(event, at);
        break;
      case 'Dial':
        this.dial(event, at);
        break;
      case 'ChannelEnteredBridge':
      case 'ChannelLeftBridge':
        if (event.channel) this.upsert(event.channel, at);
        if (event.bridge) this.setBridge(event.bridge, at);
        break;
      case 'BridgeDestroyed':
        if (event.bridge) this.setBridge({ id: event.bridge.id, channels: [] });
        break;
      case 'ChannelDestroyed': {
        const leg = event.channel && this.legs.get(event.channel.id);
        if (!leg) return;
        this.end(leg, at, event.cause ?? null, event.cause_txt ?? null);
        break;
      }
      case 'EndpointStateChange':
        if (!event.endpoint) return;
        this.setEndpoint(event.endpoint);
        break;
      case 'ContactStatusChange': {
        const aor = event.contact_info?.aor;
        const usec = Number(event.contact_info?.roundtrip_usec);
        if (!aor) return;
        if (Number.isFinite(usec) && usec > 0) {
          this.contactRtt.set(aor, Math.round(usec / 1000));
        } else {
          this.contactRtt.delete(aor);
        }
        break;
      }
      default:
        return;
    }
    this.changed();
  }

  private upsert(channel: AriChannel, at = this.now()): Leg {
    let leg = this.legs.get(channel.id);
    if (!leg) {
      leg = {
        id: channel.id,
        seenAt: this.now(),
        name: channel.name,
        endpoint: endpointOf(channel.name),
        state: channel.state ?? 'Unknown',
        caller: { name: '', number: '' },
        createdAt: parseAriTime(channel.creationtime) ?? at,
        place: EMPTY_PLACE,
        vars: {},
        dialled: false,
        trail: [],
      };
      this.legs.set(channel.id, leg);
    }
    leg.name = channel.name;
    leg.state = channel.state ?? leg.state;
    if (channel.caller) {
      leg.caller = {
        name: channel.caller.name ?? '',
        number: channel.caller.number ?? '',
      };
    }
    for (const name of TRACKED_VARS) {
      const value = channel.channelvars?.[name];
      if (value !== undefined) leg.vars[name] = value;
    }
    const dp = channel.dialplan;
    if (dp?.app_name === 'AppDial') leg.dialled = true;
    if (dp?.context !== undefined) this.move(leg, dp);
    return leg;
  }

  private move(leg: Leg, dp: NonNullable<AriChannel['dialplan']>): void {
    const context = dp.context ?? '';
    const exten = dp.exten ?? '';
    const app = dp.app_name ?? '';
    const appData = dp.app_data ?? '';
    const kind = app === 'Gosub' ? PBX_EVENT.exec(appData)?.[1] : undefined;
    if (kind && leg.trail.at(-1) !== kind) {
      leg.trail.push(kind);
      leg.verdict = VERDICTS[kind] ?? leg.verdict;
    }
    if (SUBROUTINES.has(context) || exten === 'h' || context === '') return;
    leg.place = { context, exten, app, appData };
    if (context === 'from-voipms') {
      if (exten === 'busy') leg.verdict = 'refused (busy)';
      if (exten === 'ring' && !leg.verdict) {
        if (leg.vars.CONTACT) leg.verdict = 'contact';
        else if (leg.vars.SCREEN === 'yes') leg.verdict = '911 callback';
        else leg.verdict = 'open line';
      }
    }
    if (context === 'spam' && exten === 'full') leg.verdict = 'refused (full)';
  }

  private varset(event: AriEvent, at: number): void {
    const name = event.variable?.replace(/^_+/, '');
    if (!event.channel) {
      // A global: Set(GLOBAL(EATEN)=...) in spam.conf.
      if (name === 'EATEN') {
        const eaten = Number(event.value);
        this.eaten = Number.isFinite(eaten) ? eaten : this.eaten;
      }
      return;
    }
    // The snapshot on a ChannelVarset predates the Set it reports, so the
    // event's own value is applied after it.
    const leg = this.upsert(event.channel, at);
    if (name && (TRACKED_VARS as readonly string[]).includes(name)) {
      leg.vars[name] = event.value ?? '';
    }
  }

  private dial(event: AriEvent, at: number): void {
    if (!event.peer) return;
    const peer = this.upsert(event.peer, at);
    if (event.caller && event.caller.id !== peer.id) {
      this.upsert(event.caller, at);
      peer.parent = event.caller.id;
      peer.dialled = true;
    }
  }

  private setBridge(bridge: AriBridge, at = this.now()): void {
    const previous = this.bridges.get(bridge.id) ?? new Set<string>();
    const members = new Set(bridge.channels ?? []);
    for (const id of previous) {
      const leg = this.legs.get(id);
      if (leg && !members.has(id) && leg.bridge === bridge.id) {
        leg.bridge = undefined;
      }
    }
    if (members.size === 0) {
      this.bridges.delete(bridge.id);
      return;
    }
    this.bridges.set(bridge.id, members);
    for (const id of members) {
      const leg = this.legs.get(id);
      if (!leg) continue;
      leg.bridge = bridge.id;
      const other = [...members]
        .map((m) => this.legs.get(m))
        .find((l) => l && l.id !== id);
      if (other) {
        leg.bridgedAt ??= at;
        leg.talkedWith = other.endpoint ?? other.name;
      }
    }
  }

  private setEndpoint(endpoint: AriEndpoint): void {
    const state = endpoint.state;
    this.ariEndpoints.set(
      endpoint.resource,
      state === 'online' || state === 'offline' ? state : 'unknown',
    );
  }

  private end(
    leg: Leg,
    at: number,
    cause: number | null,
    causeText: string | null,
  ): void {
    this.legs.delete(leg.id);
    const now = this.now();
    this.gone.set(leg.id, now);
    for (const [id, when] of this.gone) {
      if (now - when > GONE_MS) this.gone.delete(id);
    }
    if (leg.bridge) this.bridges.get(leg.bridge)?.delete(leg.id);
    if (leg.parent || leg.dialled) return;
    const facts = this.facts(leg);
    const partner =
      leg.talkedWith === AGENT_ENDPOINT ? AGENT_NAME : leg.talkedWith;
    const lastStage = partner ? `talked with ${partner}` : facts.stage.label;
    const call: RecentCall = {
      id: leg.id,
      direction: facts.direction,
      line: facts.line,
      trunk: facts.trunk,
      caller: leg.caller,
      dialled: facts.dialled,
      verdict: leg.verdict ?? null,
      trail: [...leg.trail],
      lastStage,
      startedAt: iso(leg.createdAt),
      endedAt: iso(at),
      seconds: Math.max(0, Math.round((at - leg.createdAt) / 1000)),
      talkedSeconds: leg.bridgedAt
        ? Math.max(0, Math.round((at - leg.bridgedAt) / 1000))
        : 0,
      cause,
      causeText,
    };
    this.recent.unshift(call);
    this.opts.onEnded?.(call);
    this.recent.length = Math.min(this.recent.length, this.opts.recentLimit);
  }

  /** The descendants of a call's first channel, through Dial's links. */
  private children(root: Leg): Leg[] {
    return [...this.legs.values()].filter((l) => l.parent === root.id);
  }

  private facts(root: Leg) {
    const endpoint = root.endpoint ?? '';
    const asTrunk = this.trunkLine.get(endpoint);
    const asLine = this.lineByName.get(endpoint);
    let direction: Direction = 'other';
    let line: string | null = null;
    let trunk: string | null = null;
    if (asTrunk || root.place.context === 'from-voipms' || root.vars.HANDSET) {
      direction = 'inbound';
      line = root.vars.HANDSET || asTrunk?.line || null;
      trunk = root.endpoint;
    } else if (asLine || root.place.context === 'from-handset') {
      direction = 'handset';
      line = root.endpoint;
      trunk = root.vars.TRUNK || asLine?.trunk || null;
    }
    const partner = root.bridge
      ? [...(this.bridges.get(root.bridge) ?? [])]
          .map((id) => this.legs.get(id))
          .find((l) => l && l.id !== root.id)
      : undefined;
    const dialling = this.children(root).find((l) => !l.bridge);
    const stage = stageOf({
      direction,
      place: root.place,
      vars: root.vars,
      trunk,
      bridgedTo: partner ? (partner.endpoint ?? partner.name) : null,
      dialling: dialling?.endpoint ?? null,
    });
    const dialled =
      direction === 'handset' && root.place.context === 'from-handset'
        ? root.place.exten
        : null;
    return { direction, line, trunk, stage, dialled };
  }

  snapshot(): BoardView {
    const calls: CallView[] = [];
    for (const leg of this.legs.values()) {
      // A dialled leg belongs to its caller's call, and one whose caller has
      // already gone is about to be destroyed itself.
      if (leg.parent || leg.dialled) continue;
      const facts = this.facts(leg);
      calls.push({
        id: leg.id,
        direction: facts.direction,
        line: facts.line,
        trunk: facts.trunk,
        caller: leg.caller,
        dialled: facts.dialled,
        stage: facts.stage,
        verdict: leg.verdict ?? null,
        trail: [...leg.trail],
        state: leg.state,
        startedAt: iso(leg.createdAt),
        talkingSince: leg.bridge && leg.bridgedAt ? iso(leg.bridgedAt) : null,
      });
    }
    calls.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const metrics = this.metrics;
    const lines: LineView[] = this.plan.map((plan) => ({
      line: plan.line,
      trunk: plan.trunk,
      account: plan.account,
      screened: plan.screened,
      handset:
        this.ariEndpoints.get(plan.line) ??
        metrics?.endpoints[plan.line] ??
        'unknown',
      handsetRttMs: this.contactRtt.get(plan.line) ?? null,
      registration:
        (plan.account && metrics?.registrations[plan.account]) || 'unknown',
      calls: calls.filter((c) => c.line === plan.line).length,
    }));
    return {
      now: iso(this.now()),
      asterisk: {
        ari: this.link,
        reason: this.linkReason,
        since: iso(this.linkSince),
        metrics: this.metricsState,
        version: metrics?.version ?? null,
        uptimeSeconds: metrics?.uptimeSeconds ?? null,
      },
      lines,
      calls,
      recent: [...this.recent],
      eaten: this.eaten,
    };
  }
}
