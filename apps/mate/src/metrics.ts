import {
  type MeterProvider,
  metrics,
  type ObservableGauge,
} from '@opentelemetry/api';
import type { SessionStartLimit } from './guard.ts';
import type { SandboxSource, StopReason } from './sandbox.ts';

/** How a turn ended, `sandbox-died` being the one the harness never reports. */
export type TurnEnd = StopReason | 'sandbox-died';

/** How far getting a thread a usable sandbox got. */
export type MintResult = 'ok' | 'mint-failed' | 'attach-failed';

/**
 * The durations behind one `minted` call, present only for the steps that
 * finished. A step that gives up takes its own timeout rather than its own
 * time, so letting a failure in would move these quantiles by an amount that
 * says nothing about how long a usable sandbox takes to arrive;
 * `mate_mints_total` is where failures are counted. There is no sample at all
 * when nothing was timed.
 */
export interface MintSample {
  source: SandboxSource;
  mintMs?: number | null;
  attachMs?: number | null;
}

/**
 * Why a sandbox went away. The hard `shutdownTime` TTL is not here: the
 * controller enforces it, and mate only ever sees its result.
 */
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
  /**
   * The warm pool as the sweep left it: what a thread could be handed right
   * now against what `MATE_SPARES` asks for. Both numbers rather than one,
   * because the pool being short is only worth knowing against the size it is
   * meant to be, and that size is a knob on the Deployment.
   */
  spares(ready: number, wanted: number): void;
  minted(result: MintResult, sample?: MintSample): void;
  /**
   * Whether mate can mint a GitHub token right now, as the boot preflight and
   * its re-check last found. It reports nothing at all where no App is
   * configured: unsetting `MATE_GITHUB_APP_ID` is the documented rollback, and
   * a gauge that read 0 in that state would make the rollback ship a
   * permanently firing critical alert. Downstream that absence looks like
   * `absent()`, exactly as the identify-budget gauges above go quiet rather
   * than hold a reading that has stopped being true.
   */
  githubAppReady(ready: boolean | null): void;
  /** One attempt to mint a turn's token; `ok` is the only non-failure spelling. */
  githubTokenMinted(result: string): void;
  /** One attempt to write a minted token into its sandbox. */
  githubTokenStamped(result: string): void;
  turnStarted(): void;
  turnEnded(reason: TurnEnd, sample: TurnSample): void;
  teardown(reason: TeardownReason): void;
}

let cached: { provider: MeterProvider; instruments: Instruments } | null = null;

/**
 * The levels the observable gauges report, kept out here so re-minting an
 * instrument does not lose what it was last told.
 */
let latest: { limit: SessionStartLimit; readAt: number } | null = null;
/** `null` until a preflight has run, and for good where no App is configured. */
let appReady: boolean | null = null;
let live = 0;
let queued = 0;
/**
 * Reported whether or not a pool is configured: with `MATE_SPARES` unset the
 * sweep never says anything and these stay at nothing wanted and nothing
 * held, which is the reading, and which is what keeps an alert comparing the
 * two quiet on a mate that was never asked for a pool.
 */
let pool = { ready: 0, wanted: 0 };

/**
 * Built on first use rather than at import so nothing is minted before a
 * metrics SDK is registered: an instrument created earlier is a no-op forever,
 * and never says so. With no SDK, the API's global meter is itself a no-op,
 * which is the stub.
 *
 * The instruments are re-minted when the global MeterProvider changes, so a
 * call that lands before `startTelemetry` costs nothing but that one record —
 * the metrics API keeps no proxy provider that re-binds on registration, the
 * way the trace and log APIs do, so without this a single early caller would
 * silently disable every instrument for the life of the process.
 *
 * Names are spelled the way Prometheus will hold them rather than in
 * OpenTelemetry's dotted style. The collector's prometheus exporter rewrites a
 * dotted name and appends the unit and `_total` on the way out, and an alert
 * can only be written against the name that survives that. Spelling them here
 * removes the guess — a name that already ends in its unit or in `total` is
 * not given a second one, so `mate_turns_total` reads the same whether the
 * exporter normalises or passes the name through. The one instrument whose
 * unit has no Prometheus spelling, USD, therefore declares no unit at all.
 */
export function getInstruments(): Instruments {
  const provider = metrics.getMeterProvider();
  if (cached?.provider === provider) return cached.instruments;
  const meter = provider.getMeter('mate');
  const observe = (
    gauge: ObservableGauge,
    pick: (l: SessionStartLimit) => number,
  ) =>
    gauge.addCallback((result) => {
      // Discord's `reset_after` is exactly how long the reading stays a fact:
      // past it the daily budget has reset and mate, still connected, has had
      // no reason to look again. Reporting the old number past that point
      // would leave an alert on the reserve firing against a budget that is
      // no longer low, with nothing able to clear it. Stopping is the honest
      // reading, and downstream it looks like `absent()`.
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
