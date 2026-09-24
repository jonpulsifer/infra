import {
  type MeterProvider,
  metrics,
  type ObservableGauge,
} from '@opentelemetry/api';
import type { SessionStartLimit } from './guard.ts';
import type { SandboxSource, StopReason } from './sandbox.ts';

/** `sandbox-died` is the one end the harness never reports. */
export type TurnEnd = StopReason | 'sandbox-died';

export type MintResult = 'ok' | 'mint-failed' | 'attach-failed';

/**
 * Only steps that finished are timed, since a failed step's time is its
 * timeout. `mate_mints_total` counts failures.
 */
export interface MintSample {
  source: SandboxSource;
  mintMs?: number | null;
  attachMs?: number | null;
}

/** No TTL reason: the controller enforces `shutdownTime` out of mate's sight. */
export type TeardownReason =
  | 'quiet'
  | 'archived'
  | 'error'
  | 'restart'
  | 'thread-deleted';

export interface TurnSample {
  firstTokenMs?: number | null;
  costUsd?: number | null;
}

export interface Instruments {
  identifyLimit(limit: SessionStartLimit): void;
  gatewayClosed(code: number, fatal: boolean): void;
  sandboxesLive(count: number): void;
  queueDepth(depth: number): void;
  /** Both, because a short pool matters only against its configured size. */
  spares(ready: number, wanted: number): void;
  minted(result: MintResult, sample?: MintSample): void;
  /** `null` (no App) reports nothing, since a 0 would fire the alert forever. */
  githubAppReady(ready: boolean | null): void;
  /** `ok` is the only non-failure result. */
  githubTokenMinted(result: string): void;
  githubTokenStamped(result: string): void;
  turnStarted(): void;
  turnEnded(reason: TurnEnd, sample: TurnSample): void;
  teardown(reason: TeardownReason): void;
}

let cached: { provider: MeterProvider; instruments: Instruments } | null = null;

// Module state, so re-minted instruments keep the last readings.
let latest: { limit: SessionStartLimit; readAt: number } | null = null;
/** `null` until a preflight has run, and for good where no App is configured. */
let appReady: boolean | null = null;
let live = 0;
let queued = 0;
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
  meter
    .createObservableGauge('mate_sandboxes_live')
    .addCallback((result) => result.observe(live));
  meter
    .createObservableGauge('mate_queue_depth')
    .addCallback((result) => result.observe(queued));
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
  const closes = meter.createCounter('mate_gateway_closes_total');
  const mints = meter.createCounter('mate_mints_total');
  const turns = meter.createCounter('mate_turns_total');
  const ended = meter.createCounter('mate_turns_ended_total');
  const teardowns = meter.createCounter('mate_teardowns_total');
  const tokenMints = meter.createCounter('mate_github_token_mints_total');
  const tokenStamps = meter.createCounter('mate_github_token_stamps_total');
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
  const attachDuration = meter.createHistogram(
    'mate_attach_duration_milliseconds',
    { unit: 'ms' },
  );
  const instruments: Instruments = {
    identifyLimit: (limit) => {
      latest = { limit, readAt: Date.now() };
    },
    gatewayClosed: (code, fatal) =>
      closes.add(1, { code: String(code), fatal: String(fatal) }),
    sandboxesLive: (count) => {
      live = count;
    },
    queueDepth: (depth) => {
      queued = depth;
    },
    spares: (ready, wanted) => {
      pool = { ready, wanted };
    },
    githubAppReady: (ready) => {
      appReady = ready;
    },
    githubTokenMinted: (result) => tokenMints.add(1, { result }),
    githubTokenStamped: (result) => tokenStamps.add(1, { result }),
    minted: (result, sample) => {
      mints.add(1, { result });
      if (!sample) return;
      const { source } = sample;
      if (typeof sample.mintMs === 'number') {
        mintDuration.record(sample.mintMs, { source });
      }
      if (typeof sample.attachMs === 'number') {
        attachDuration.record(sample.attachMs, { source });
      }
    },
    turnStarted: () => turns.add(1),
    turnEnded: (reason, sample) => {
      ended.add(1, { reason });
      if (typeof sample.firstTokenMs === 'number') {
        firstToken.record(sample.firstTokenMs, { reason });
      }
      if (typeof sample.costUsd === 'number') cost.record(sample.costUsd);
    },
    teardown: (reason) => teardowns.add(1, { reason }),
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
    queueDepth: (depth) => getInstruments().queueDepth(depth),
    spares: (ready, wanted) => getInstruments().spares(ready, wanted),
    minted: (result, sample) => getInstruments().minted(result, sample),
    githubAppReady: (ready) => getInstruments().githubAppReady(ready),
    githubTokenMinted: (result) => getInstruments().githubTokenMinted(result),
    githubTokenStamped: (result) => getInstruments().githubTokenStamped(result),
    turnStarted: () => getInstruments().turnStarted(),
    turnEnded: (reason, sample) => getInstruments().turnEnded(reason, sample),
    teardown: (reason) => getInstruments().teardown(reason),
  };
}
