import type { AriBridge, AriChannel, AriEndpoint } from './ari-types.ts';
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
 * The channel variables the board reads from each channel in ARI's list.
 * TRAIL is the `pbx-event` kinds the call has logged, which config/events.conf
 * appends to: a Gosub that short falls between two polls.
 */
export const TRACKED_VARS = [
  'HANDSET',
  'TRUNK',
  'SCREEN',
  'CONTACT',
  'SINK',
  'TRAIL',
] as const;

/**
 * ari.conf's `channelvars`, in order: the tracked variables, then the global
 * EATEN, which a channel without its own reads through to.
 */
export const CHANNEL_VARS = [...TRACKED_VARS, 'EATEN'] as const;

// Dial's pre-dial handlers, which run on the leg Dial is ringing. A leg seen
// in one is that leg, even before Dial marks it AppDial.
const PREDIAL = ['handset-leg', 'agent-leg'];

/**
 * Dialplan a call passes through without moving: the event logger, Dial's
 * pre-dial handlers, and the sinks' and the agent's hangup handlers. Each
 * context's `h` is the same.
 */
export const SUBROUTINES: ReadonlySet<string> = new Set([
  'pbx-event',
  ...PREDIAL,
  'spam-held',
  'agent-held',
]);

/** events.conf's kinds that decide how the PBX treated a caller. */
export const VERDICTS: Readonly<Record<string, string>> = {
  contact: 'contact',
  'captcha-pass': 'pressed 5',
  screened: 'screened',
};

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
}

export interface LineView {
  readonly line: string;
  readonly trunk: string | null;
  readonly account: string | null;
  readonly screened: boolean;
  readonly handset: EndpointState;
  readonly registration: Registration | 'unknown';
  readonly calls: number;
}

export type AriLink = 'connecting' | 'connected' | 'disconnected';

export interface AsteriskView {
  readonly ari: AriLink;
  /**
   * Why the last poll failed: `unauthorized`, `forbidden`, `unreachable` or
   * `http-error`.
   */
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
  /** The last poll that listed it, by the board's clock. */
  lastSeen: number;
  name: string;
  endpoint: string | null;
  state: string;
  caller: Party;
  createdAt: number;
  place: Place;
  vars: Record<string, string>;
  /** A leg Dial is ringing, known by its app or its pre-dial handler. */
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

/** PJSIP/line4-0000002a names endpoint line4. */
function endpointOf(name: string): string | null {
  const match = /^PJSIP\/(.+)-[0-9a-f]+$/.exec(name);
  return match ? (match[1] as string) : null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Dial(PJSIP/line4&PJSIP/6135550123@vms-cathy,...) rings line4 and vms-cathy. */
function dialTargets(appData: string): string[] {
  const targets = (appData.split(',')[0] ?? '').split('&');
  return targets.flatMap((target) => {
    const match = /^PJSIP\/(?:[^@]*@)?(.+)$/.exec(target.trim());
    return match ? [match[1] as string] : [];
  });
}

/**
 * The PBX as the board shows it: every channel ARI lists, folded into calls
 * keyed by the channel that started them, plus the four lines and the calls
 * that ended while the board watched. It does no I/O; the ARI client feeds it
 * each poll's lists and the server reads snapshots.
 */
export class BoardModel {
  private readonly legs = new Map<string, Leg>();
  private readonly bridges = new Map<string, Set<string>>();
  private readonly ariEndpoints = new Map<string, EndpointState>();
  private recent: RecentCall[] = [];
  private metrics: PbxMetrics | undefined;
  private metricsState: AsteriskView['metrics'] = 'unknown';
  private link: AriLink = 'connecting';
  private linkReason: string | null = null;
  private linkSince: number;
  private eaten: number | null = null;
  private readonly listeners = new Set<() => void>();
  private notified = '';
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

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Each poll reloads the lists, so only a snapshot that differs from the
  // last one told is news; the clock alone is not.
  private changed(): void {
    const { now: _, ...view } = this.snapshot();
    const signature = JSON.stringify(view);
    if (signature === this.notified) return;
    this.notified = signature;
    for (const listener of this.listeners) listener();
  }

  setLink(link: AriLink, reason: string | null = null): void {
    if (link === this.link && reason === this.linkReason) return;
    this.link = link;
    this.linkReason = reason;
    this.linkSince = this.now();
    // EATEN starts again with the PBX, and a PBX that restarts is one the
    // board lost for a while, so the count comes back from the next channel.
    if (link === 'disconnected') this.eaten = null;
    this.changed();
  }

  setMetrics(metrics: PbxMetrics | undefined): void {
    if (metrics) this.metrics = metrics;
    this.metricsState = metrics ? 'ok' : 'failing';
    this.changed();
  }

  /**
   * Replaces every channel and bridge with one poll's lists. A channel the
   * lists no longer name has ended, as of the last poll that named it.
   */
  load(state: {
    channels: readonly AriChannel[];
    bridges: readonly AriBridge[];
    endpoints?: readonly AriEndpoint[];
  }): void {
    const now = this.now();
    const live = new Set(state.channels.map((c) => c.id));
    for (const leg of [...this.legs.values()]) {
      if (!live.has(leg.id)) this.end(leg);
    }
    for (const channel of state.channels) this.upsert(channel, now);
    this.setBridges(state.bridges, now);
    for (const endpoint of state.endpoints ?? []) this.setEndpoint(endpoint);
    this.changed();
  }

  private upsert(channel: AriChannel, now: number): void {
    let leg = this.legs.get(channel.id);
    if (!leg) {
      leg = {
        id: channel.id,
        lastSeen: now,
        name: channel.name,
        endpoint: endpointOf(channel.name),
        state: channel.state ?? 'Unknown',
        caller: { name: '', number: '' },
        createdAt: parseAriTime(channel.creationtime) ?? now,
        place: EMPTY_PLACE,
        vars: {},
        dialled: false,
        trail: [],
      };
      this.legs.set(channel.id, leg);
    }
    leg.lastSeen = now;
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
    this.countEaten(channel.channelvars?.EATEN);
    const trail = (leg.vars.TRAIL ?? '').split(/\s+/).filter(Boolean);
    for (const kind of trail.slice(leg.trail.length)) {
      leg.verdict = VERDICTS[kind] ?? leg.verdict;
    }
    leg.trail = trail;
    const dp = channel.dialplan;
    if (dp?.app_name === 'AppDial' || PREDIAL.includes(dp?.context ?? '')) {
      leg.dialled = true;
    }
    if (dp?.context !== undefined) this.move(leg, dp);
  }

  // GLOBAL(EATEN) only grows while the PBX runs, and each channel carries it
  // as of its own last step, so the largest is the newest.
  private countEaten(value: string | undefined): void {
    if (!value) return;
    const eaten = Number(value);
    if (Number.isFinite(eaten)) this.eaten = Math.max(this.eaten ?? 0, eaten);
  }

  private move(leg: Leg, dp: NonNullable<AriChannel['dialplan']>): void {
    const context = dp.context ?? '';
    const exten = dp.exten ?? '';
    const app = dp.app_name ?? '';
    const appData = dp.app_data ?? '';
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

  private setBridges(bridges: readonly AriBridge[], at: number): void {
    this.bridges.clear();
    for (const leg of this.legs.values()) leg.bridge = undefined;
    for (const bridge of bridges) {
      // The two lists are read at once, so a bridge can name a channel the
      // channel list has not caught up with; the next poll places it.
      const members = (bridge.channels ?? [])
        .map((id) => this.legs.get(id))
        .filter((leg): leg is Leg => leg !== undefined);
      if (members.length === 0) continue;
      this.bridges.set(bridge.id, new Set(members.map((leg) => leg.id)));
      for (const leg of members) {
        leg.bridge = bridge.id;
        const other = members.find((l) => l.id !== leg.id);
        if (other) {
          leg.bridgedAt ??= at;
          leg.talkedWith = other.endpoint ?? other.name;
        }
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

  private end(leg: Leg): void {
    this.legs.delete(leg.id);
    if (leg.dialled) return;
    const at = leg.lastSeen;
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
    };
    this.recent.unshift(call);
    this.opts.onEnded?.(call);
    this.recent.length = Math.min(this.recent.length, this.opts.recentLimit);
  }

  /** The leg a root's Dial is ringing: one of its targets, not yet bridged. */
  private ringing(root: Leg): Leg | undefined {
    if (root.place.app !== 'Dial') return undefined;
    const targets = dialTargets(root.place.appData);
    return [...this.legs.values()].find(
      (leg) =>
        leg.dialled &&
        !leg.bridge &&
        leg.endpoint !== null &&
        targets.includes(leg.endpoint),
    );
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
    const dialling = this.ringing(root);
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
      if (leg.dialled) continue;
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
