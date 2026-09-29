import {
  type MeterProvider,
  metrics,
  type ObservableGauge,
} from '@opentelemetry/api';
import type { McpInstruments } from './brain-inputs.ts';
import type { SessionStartLimit } from './guard.ts';
import type {
  HandsCallResult,
  HandsConnectResult,
  HandsConnectSample,
  HandsDropReason,
  HandsInstruments,
  MintResult,
  MintSample,
  TurnSandboxSource,
} from './lease.ts';
import type { StopReason } from './sandbox.ts';

/** `brain-failed`: the brain or its store threw, so the harness never reported an end. */
export type TurnEnd = StopReason | 'brain-failed';

export interface TurnSample {
  firstTokenMs?: number | null;
  costUsd?: number | null;
}

/** How a turn a restart cut off came out. */
export type TurnResumeResult = 'resumed' | 'lost' | 'discarded';

export type ProviderErrorKind = 'limit' | 'auth' | 'timeout' | 'other';

export type StoreOp =
  | 'open'
  | 'fault'
  | 'rows'
  | 'migrate'
  | 'quarantine'
  | 'credentials';

export interface ChatgptSignIn {
  readonly signedIn: boolean;
  /** When the access token expires, in epoch ms; null while signed out. */
  readonly expiresAt: number | null;
}

/** The bounded set a tool's name is counted under. */
export type ToolLabel = 'bash' | 'read' | 'write' | 'edit' | 'kthx' | 'other';

export function toolLabel(tool: string): ToolLabel {
  const base = ['bash', 'read', 'write', 'edit'] as const;
  const known = base.find((name) => name === tool);
  if (known) return known;
  return tool.startsWith('kthx_') ? 'kthx' : 'other';
}

export interface Instruments extends HandsInstruments, McpInstruments {
  identifyLimit(limit: SessionStartLimit): void;
  gatewayClosed(code: number, fatal: boolean): void;
  queueDepth(depth: number): void;
  turnsRunning(count: number): void;
  /** `null` (no App) reports nothing, since a 0 would fire the alert forever. */
  githubAppReady(ready: boolean | null): void;
  turnStarted(): void;
  turnEnded(reason: TurnEnd, sample: TurnSample): void;
  turnResumed(result: TurnResumeResult): void;
  toolEnded(tool: string, isError: boolean): void;
  providerError(kind: ProviderErrorKind): void;
  storeFailed(op: StoreOp): void;
  /** `null` reports nothing: mate has no credential store, or has not read it yet. */
  chatgpt(state: ChatgptSignIn | null): void;
}

let cached: { provider: MeterProvider; instruments: Instruments } | null = null;

// Module state, so re-minted instruments keep the last readings.
let latest: { limit: SessionStartLimit; readAt: number } | null = null;
/** `null` until a preflight has run, and for good where no App is configured. */
let appReady: boolean | null = null;
/** `null` until a bridge is configured, so the gauge is absent without one. */
let mcp: boolean | null = null;
let chatgpt: ChatgptSignIn | null = null;
let live = 0;
let waiters = 0;
let queued = 0;
let running = 0;
// With no pool configured both stay 0, which keeps a ready-versus-wanted alert
// quiet.
let pool = { ready: 0, wanted: 0 };

/**
 * Re-mints when the global MeterProvider changes: the metrics API has no proxy
 * provider, so an instrument minted before the SDK stays a no-op.
 */
export function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached.instruments;
  // Names already carry their Prometheus unit and `_total`, so the collector's
  // exporter passes them through as alerts spell them.
  const meter = provider.getMeter('mate');
  const observe = (
    gauge: ObservableGauge,
    pick: (l: SessionStartLimit) => number,
  ) =>
    gauge.addCallback((result) => {
      // Past `reset_after` the budget has reset, so a stale low reading would
      // keep a reserve alert firing.
      if (!latest) return;
      if (Date.now() - latest.readAt >= latest.limit.reset_after) return;
      result.observe(pick(latest.limit));
    });
  observe(
    meter.createObservableGauge('mate_discord_session_start_limit'),
    (l) => l.total,
  );
  observe(
    meter.createObservableGauge('mate_discord_session_start_remaining'),
    (l) => l.remaining,
  );
  observe(
    meter.createObservableGauge(
      'mate_discord_session_start_reset_after_milliseconds',
      { unit: 'ms' },
    ),
    (l) => l.reset_after,
  );
  observe(
    meter.createObservableGauge('mate_discord_session_start_max_concurrency'),
    (l) => l.max_concurrency,
  );
  // Reported on every collection: MateNotReporting fires on its absence.
  meter
    .createObservableGauge('mate_sandboxes_live')
    .addCallback((result) => result.observe(live));
  meter
    .createObservableGauge('mate_sandbox_waiters')
    .addCallback((result) => result.observe(waiters));
  meter
    .createObservableGauge('mate_queue_depth')
    .addCallback((result) => result.observe(queued));
  meter
    .createObservableGauge('mate_turns_running')
    .addCallback((result) => result.observe(running));
  meter
    .createObservableGauge('mate_spares_ready')
    .addCallback((result) => result.observe(pool.ready));
  meter
    .createObservableGauge('mate_spares_wanted')
    .addCallback((result) => result.observe(pool.wanted));
  meter.createObservableGauge('mate_github_app_ready').addCallback((result) => {
    if (appReady === null) return;
    result.observe(appReady ? 1 : 0);
  });
  meter.createObservableGauge('mate_mcp_up').addCallback((result) => {
    if (mcp === null) return;
    result.observe(mcp ? 1 : 0);
  });
  meter
    .createObservableGauge('mate_chatgpt_signed_in')
    .addCallback((result) => {
      if (chatgpt === null) return;
      result.observe(chatgpt.signedIn ? 1 : 0);
    });
  // Seconds left at collection time, so the alert needs no clock of its own.
  meter
    .createObservableGauge('mate_chatgpt_token_expiry_seconds', { unit: 's' })
    .addCallback((result) => {
      if (chatgpt?.expiresAt == null) return;
      result.observe(Math.round((chatgpt.expiresAt - Date.now()) / 1000));
    });
  const closes = meter.createCounter('mate_gateway_closes_total');
  const mints = meter.createCounter('mate_mints_total');
  const turns = meter.createCounter('mate_turns_total');
  const ended = meter.createCounter('mate_turns_ended_total');
  const resumes = meter.createCounter('mate_turn_resumes_total');
  const teardowns = meter.createCounter('mate_teardowns_total');
  const tokenMints = meter.createCounter('mate_github_token_mints_total');
  const tokenStamps = meter.createCounter('mate_github_token_stamps_total');
  const siteSyncs = meter.createCounter('mate_kthx_sites_syncs_total');
  const connects = meter.createCounter('mate_hands_connects_total');
  const drops = meter.createCounter('mate_hands_drops_total');
  const turnSandboxes = meter.createCounter('mate_turn_sandboxes_total');
  const toolCalls = meter.createCounter('mate_tool_calls_total');
  const providerErrors = meter.createCounter('mate_provider_errors_total');
  const storeFailures = meter.createCounter('mate_store_failures_total');
  const mcpCalls = meter.createCounter('mate_mcp_calls_total');
  const firstToken = meter.createHistogram(
    'mate_turn_first_token_milliseconds',
    { unit: 'ms' },
  );
  // USD has no Prometheus unit, so this declares none.
  const cost = meter.createHistogram('mate_turn_cost_usd');
  const mintDuration = meter.createHistogram(
    'mate_mint_duration_milliseconds',
    { unit: 'ms' },
  );
  const execOpen = meter.createHistogram('mate_exec_open_milliseconds', {
    unit: 'ms',
  });
  const handsConnect = meter.createHistogram(
    'mate_hands_connect_milliseconds',
    { unit: 'ms' },
  );
  const handsCall = meter.createHistogram('mate_hands_call_milliseconds', {
    unit: 'ms',
  });
  const instruments: Instruments = {
    identifyLimit: (limit) => {
      latest = { limit, readAt: Date.now() };
    },
    gatewayClosed: (code, fatal) =>
      closes.add(1, { code: String(code), fatal: String(fatal) }),
    sandboxesLive: (count) => {
      live = count;
    },
    sandboxWaiters: (count) => {
      waiters = count;
    },
    queueDepth: (depth) => {
      queued = depth;
    },
    turnsRunning: (count) => {
      running = count;
    },
    spares: (ready, wanted) => {
      pool = { ready, wanted };
    },
    githubAppReady: (ready) => {
      appReady = ready;
    },
    githubTokenMinted: (result) => tokenMints.add(1, { result }),
    githubTokenStamped: (result) => tokenStamps.add(1, { result }),
    kthxSitesSynced: (result) => siteSyncs.add(1, { result }),
    minted: (result: MintResult, sample?: MintSample) => {
      mints.add(1, { result });
      if (typeof sample?.mintMs === 'number') {
        mintDuration.record(sample.mintMs, { source: sample.source });
      }
    },
    handsConnected: (
      result: HandsConnectResult,
      sample: HandsConnectSample,
    ) => {
      connects.add(1, { result, reconnect: String(sample.reconnect) });
      if (typeof sample.execOpenMs === 'number') {
        execOpen.record(sample.execOpenMs);
      }
      if (typeof sample.connectMs === 'number') {
        handsConnect.record(sample.connectMs);
      }
    },
    handsCall: (method: string, result: HandsCallResult, ms: number) =>
      handsCall.record(ms, { method, result }),
    handsDropped: (reason: HandsDropReason) => drops.add(1, { reason }),
    teardown: (reason) => teardowns.add(1, { reason }),
    turnSandbox: (source: TurnSandboxSource) =>
      turnSandboxes.add(1, { source }),
    mcpUp: (up) => {
      mcp = up;
    },
    mcpCall: (result) => mcpCalls.add(1, { result }),
    turnStarted: () => turns.add(1),
    turnEnded: (reason, sample) => {
      ended.add(1, { reason });
      if (typeof sample.firstTokenMs === 'number') {
        firstToken.record(sample.firstTokenMs, { reason });
      }
      if (typeof sample.costUsd === 'number') cost.record(sample.costUsd);
    },
    turnResumed: (result) => resumes.add(1, { result }),
    toolEnded: (tool, isError) =>
      toolCalls.add(1, {
        tool: toolLabel(tool),
        result: isError ? 'error' : 'ok',
      }),
    providerError: (kind) => providerErrors.add(1, { kind }),
    storeFailed: (op) => storeFailures.add(1, { op }),
    chatgpt: (state) => {
      chatgpt = state;
    },
  };
  cached = { provider, instruments };
  return instruments;
}

/** Defers every mint to the first call, so holding this reference mints nothing. */
export function lazyInstruments(): Instruments {
  return {
    identifyLimit: (limit) => getInstruments().identifyLimit(limit),
    gatewayClosed: (code, fatal) => getInstruments().gatewayClosed(code, fatal),
    sandboxesLive: (count) => getInstruments().sandboxesLive(count),
    sandboxWaiters: (count) => getInstruments().sandboxWaiters(count),
    queueDepth: (depth) => getInstruments().queueDepth(depth),
    turnsRunning: (count) => getInstruments().turnsRunning(count),
    spares: (ready, wanted) => getInstruments().spares(ready, wanted),
    minted: (result, sample) => getInstruments().minted(result, sample),
    handsConnected: (result, sample) =>
      getInstruments().handsConnected(result, sample),
    handsCall: (method, result, ms) =>
      getInstruments().handsCall(method, result, ms),
    handsDropped: (reason) => getInstruments().handsDropped(reason),
    githubAppReady: (ready) => getInstruments().githubAppReady(ready),
    githubTokenMinted: (result) => getInstruments().githubTokenMinted(result),
    githubTokenStamped: (result) => getInstruments().githubTokenStamped(result),
    kthxSitesSynced: (result) => getInstruments().kthxSitesSynced(result),
    teardown: (reason) => getInstruments().teardown(reason),
    turnSandbox: (source) => getInstruments().turnSandbox(source),
    mcpUp: (up) => getInstruments().mcpUp(up),
    mcpCall: (result) => getInstruments().mcpCall(result),
    turnStarted: () => getInstruments().turnStarted(),
    turnEnded: (reason, sample) => getInstruments().turnEnded(reason, sample),
    turnResumed: (result) => getInstruments().turnResumed(result),
    toolEnded: (tool, isError) => getInstruments().toolEnded(tool, isError),
    providerError: (kind) => getInstruments().providerError(kind),
    storeFailed: (op) => getInstruments().storeFailed(op),
    chatgpt: (state) => getInstruments().chatgpt(state),
  };
}
