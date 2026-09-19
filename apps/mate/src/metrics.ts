import { metrics, type ObservableGauge } from '@opentelemetry/api';
import type { SessionStartLimit } from './guard.ts';
import type { StopReason } from './sandbox.ts';

/** How a turn ended, `sandbox-died` being the one the harness never reports. */
export type TurnEnd = StopReason | 'sandbox-died';

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
  sandboxesLive(count: number): void;
  queueDepth(depth: number): void;
  turnStarted(): void;
  turnEnded(reason: TurnEnd, sample: TurnSample): void;
  teardown(reason: TeardownReason): void;
}

let instruments: Instruments | null = null;

/**
 * Built on first use rather than at import so nothing is minted before a
 * metrics SDK is registered: an instrument created earlier is a no-op forever.
 * With no SDK, the API's global meter is itself a no-op, which is the stub.
 */
export function getInstruments(): Instruments {
  if (instruments) return instruments;
  const meter = metrics.getMeter('mate');
  let latest: SessionStartLimit | null = null;
  const observe = (
    gauge: ObservableGauge,
    pick: (l: SessionStartLimit) => number,
  ) =>
    gauge.addCallback((result) => {
      if (latest) result.observe(pick(latest));
    });
  observe(
    meter.createObservableGauge('discord.session_start.total'),
    (l) => l.total,
  );
  observe(
    meter.createObservableGauge('discord.session_start.remaining'),
    (l) => l.remaining,
  );
  observe(
    meter.createObservableGauge('discord.session_start.reset_after_ms'),
    (l) => l.reset_after,
  );
  observe(
    meter.createObservableGauge('discord.session_start.max_concurrency'),
    (l) => l.max_concurrency,
  );
  let live = 0;
  meter
    .createObservableGauge('mate.sandboxes.live')
    .addCallback((result) => result.observe(live));
  let queued = 0;
  meter
    .createObservableGauge('mate.queue.depth')
    .addCallback((result) => result.observe(queued));
  const turns = meter.createCounter('mate.turns');
  const ended = meter.createCounter('mate.turns.ended');
  const teardowns = meter.createCounter('mate.teardowns');
  const firstToken = meter.createHistogram('mate.turn.first_token', {
    unit: 'ms',
  });
  const cost = meter.createHistogram('mate.turn.cost_usd', { unit: 'USD' });
  instruments = {
    identifyLimit: (limit) => {
      latest = limit;
    },
    sandboxesLive: (count) => {
      live = count;
    },
    queueDepth: (depth) => {
      queued = depth;
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
  return instruments;
}

/** Defers every mint to the first call, so holding this reference mints nothing. */
export function lazyInstruments(): Instruments {
  return {
    identifyLimit: (limit) => getInstruments().identifyLimit(limit),
    sandboxesLive: (count) => getInstruments().sandboxesLive(count),
    queueDepth: (depth) => getInstruments().queueDepth(depth),
    turnStarted: () => getInstruments().turnStarted(),
    turnEnded: (reason, sample) => getInstruments().turnEnded(reason, sample),
    teardown: (reason) => getInstruments().teardown(reason),
  };
}
