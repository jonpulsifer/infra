/**
 * The hands side of the brain: what a turn asks of the sandboxes. A turn
 * leases its thread's sandbox on the first tool call, reaches it through one
 * mate-hands link, and gives it back when the turn ends.
 */
import type { ExecutionEnv } from '@earendil-works/pi-durable/env';
import type { Clock } from './clock.ts';
import type { SandboxConfig } from './config.ts';
import type { KthxSites } from './kthx-sites.ts';
import type { Kube } from './kube.ts';
import type { Log } from './log.ts';
import type { Lane, Profile } from './profiles.ts';
import type { ThreadRef } from './surface.ts';

export const WORKSPACE = '/workspace';
export const AGENT_HOME = '/home/agent';
/** The controller deletes a sandbox this long after its last slide. */
export const TTL_MS = 2 * 60 * 60_000;
/** The synthetic tool card that shows the lease inside a turn. */
export const SANDBOX_CARD_ID = 'sandbox';
/** On every sandbox this code mints, set to the mate-hands protocol it speaks. */
export const HANDS_LABEL = 'lolwtf.ca/hands';
/** What `TurnLease.abandon` may spend at SIGTERM. */
export const ABANDON_BUDGET_MS = 3_000;
/** What `Hands.start` may spend before boot carries on; condemning continues in the background. */
export const START_BUDGET_MS = 30_000;

export type SandboxSource = 'fresh' | 'reused' | 'spare';

export type MintStep =
  | 'reusing'
  | 'adopting'
  | 'refreshing'
  | 'creating'
  | 'booting';

export type OnMintStep = (step: MintStep) => void;

/** What a turn's tool calls found; `none` for a turn that ran no tool. */
export type TurnSandboxSource = SandboxSource | 'none' | 'failed';

export type TeardownReason =
  | 'quiet'
  | 'archived'
  | 'error'
  | 'restart'
  | 'thread-deleted'
  | 'preempted'
  | 'inherited'
  /** A job thread's turn is done. */
  | 'finished';

/** Why a sandbox a thread held is gone: mate tore it down, or it died. */
export type SandboxGoneReason = TeardownReason | 'lost';

/** News of the lease, which the brain draws as the `sandbox` card. */
export type LeaseEvent =
  /** Every sandbox slot is held by a busy thread. */
  | { readonly kind: 'waiting'; readonly ahead: number }
  | { readonly kind: 'step'; readonly step: MintStep }
  | { readonly kind: 'connecting' }
  | {
      readonly kind: 'ready';
      readonly sandbox: string;
      readonly source: SandboxSource;
    }
  /** No sandbox this turn; every later call in the turn fails with this. */
  | { readonly kind: 'failed'; readonly error: string }
  /** The sandbox died mid-turn; the next call starts a fresh one, once. */
  | { readonly kind: 'lost'; readonly sandbox: string; readonly error: string };

/** Both sync; neither throws. */
export interface ThreadHandsHooks {
  /** The thread's sandbox is Ready under this name. */
  onSandbox(name: string): void;
  /** A sandbox the thread held is gone, with its uncommitted work. */
  onSandboxGone(reason: SandboxGoneReason): void;
}

export interface TurnLeaseOptions {
  /** Sync; never throws. */
  onEvent(event: LeaseEvent): void;
  /** Aborted when the turn ends: it bounds the wait for a slot, not a mint already started. */
  signal: AbortSignal;
}

export interface TurnLeaseSummary {
  source: TurnSandboxSource;
  sandbox: string | null;
  /** Credentials were written this turn, and so were retired at its end. */
  stamped: boolean;
}

export interface TurnLease {
  /**
   * Before a resume: reconnects to the thread's sandbox, if it has one, so the
   * new epoch kills commands a dead mate left running. Never mints; never throws.
   */
  warm(): Promise<void>;
  /**
   * Retires what was stamped, over the link or else a one-shot exec, revokes
   * the GitHub token, closes the link, slides the TTL and marks the slot idle.
   * The first of `finish` and `abandon` does the work and a later call awaits
   * it. Never throws.
   */
  finish(): Promise<TurnLeaseSummary>;
  /**
   * SIGTERM, after the harness has closed: revokes the token, retires
   * best-effort and closes the link within `ABANDON_BUDGET_MS`. Terminal:
   * every later env call fails at once, with no connect, mint or stamp.
   * Never throws.
   */
  abandon(): Promise<void>;
}

export interface ThreadHands {
  /** The same object for the thread's life in this process: pi keys its write queue on it. */
  readonly env: ExecutionEnv;
  /**
   * Throws when a lease is already open for this thread. Marks the thread's
   * sandbox slot, if it holds one, busy until `finish` or `abandon`, so a
   * running turn is never preempted.
   */
  beginTurn(options: TurnLeaseOptions): TurnLease;
}

export interface Hands {
  /**
   * Creates the thread's hands under `profile`, or returns them with `hooks`
   * replaced. A thread keeps its profile for life: a sandbox is minted for one
   * profile and never handed to another, so a different one throws.
   */
  thread(
    ref: ThreadRef,
    hooks: ThreadHandsHooks,
    profile: Profile,
  ): ThreadHands;
  /** Keeps its kthx sites, deletes its sandbox and forgets its hands. Never throws. */
  release(ref: ThreadRef, reason: TeardownReason): Promise<void>;
  /** Pool upkeep, on a timer. */
  ensureSpares(): Promise<void>;
  /**
   * Boot, within `START_BUDGET_MS`: counts labelled thread sandboxes against
   * the cap, and returns the threads whose inherited (unlabelled) sandbox had a
   * turn in flight. Condemning inherited sandboxes carries on in the
   * background. Never throws.
   */
  start(): Promise<readonly ThreadRef[]>;
  /** SIGTERM: abandons every lease still open. Never throws. */
  shutdown(): Promise<void>;
}

// Mint and revoke only, so nothing here can reach the App's private key.
export interface TokenSource {
  token(): Promise<{ token: string }>;
  revoke(token: string): Promise<void>;
}

export interface KubeHandsDeps {
  kube: Kube;
  config: SandboxConfig;
  guildId: string;
  /** MATE_MAX_SANDBOXES. */
  maxSandboxes: number;
  log: Log;
  clock?: Clock;
  metrics?: HandsInstruments;
  githubApp?: TokenSource | null;
  kthxSites?: KthxSites | null;
  clusterCa?: string | null;
  sshKey?: string | null;
  ttlMs?: number;
  readyTimeoutMs?: number;
  goneTimeoutMs?: number;
}

export type MintResult = 'ok' | 'mint-failed' | 'connect-failed';

/** Only finished steps are timed. */
export interface MintSample {
  source: SandboxSource;
  mintMs?: number | null;
}

export type HandsConnectResult = 'ok' | 'superseded' | 'mismatch' | 'failed';

export interface HandsConnectSample {
  reconnect: boolean;
  execOpenMs?: number | null;
  connectMs?: number | null;
}

export type HandsCallResult = 'ok' | 'error' | 'aborted' | 'deadline' | 'lost';

export type HandsDropReason =
  | 'closed'
  | 'unresponsive'
  | 'deadline'
  | 'abort-grace';

/** The instruments the hands record; `metrics.ts` implements them. */
export interface HandsInstruments {
  sandboxesLive(count: number): void;
  /** Reported for both lanes on every change; the alerts count the interactive one. */
  sandboxWaiters(count: number, lane: Lane): void;
  spares(ready: number, wanted: number): void;
  minted(result: MintResult, sample?: MintSample): void;
  handsConnected(result: HandsConnectResult, sample: HandsConnectSample): void;
  handsCall(method: string, result: HandsCallResult, ms: number): void;
  handsDropped(reason: HandsDropReason): void;
  githubTokenMinted(result: string): void;
  githubTokenStamped(result: string): void;
  kthxSitesSynced(result: string): void;
  teardown(reason: TeardownReason): void;
  turnSandbox(source: TurnSandboxSource): void;
}
