import { metrics, type ObservableGauge } from '@opentelemetry/api';
import type { SessionStartLimit } from './guard.ts';

export interface Instruments {
  identifyLimit(limit: SessionStartLimit): void;
  turnStarted(): void;
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
  const turns = meter.createCounter('mate.turns');
  instruments = {
    identifyLimit: (limit) => {
      latest = limit;
    },
    turnStarted: () => turns.add(1),
  };
  return instruments;
}
