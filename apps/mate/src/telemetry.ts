/**
 * Registers the metrics SDK; nothing else in mate does. With no OTLP endpoint
 * nothing is registered and every record is a no-op.
 */
import { metrics } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  AggregationType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type ViewOptions,
} from '@opentelemetry/sdk-metrics';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import type { Log } from './log.ts';

// The only resource attribute: the exporter would make `service.instance.id` a
// label, splitting every pod into its own series.
export const SERVICE_NAME = 'mate';

export const EXPORT_INTERVAL_MS = 15_000;
export const EXPORT_TIMEOUT_MS = 5_000;

// Dense in the seconds, because `histogram_quantile` interpolates within a
// bucket. The top edge is `READY_TIMEOUT_MS`.
export const MINT_BOUNDARIES = [
  2_000, 3_000, 5_000, 7_500, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

// Opening the exec is two API calls; the hello rides it. The top edge covers a
// connect that waits out a slow kata exec.
export const CONNECT_BOUNDARIES = [
  50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000,
];

// A file call is milliseconds; an exec runs as long as its command, up to a
// turn's worth.
export const HANDS_CALL_BOUNDARIES = [
  5, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 10_000, 60_000, 600_000,
];

// Sized for qwen3.8-max's list price of about $2/M input and $6/M output.
export const COST_BOUNDARIES = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function buckets(instrumentName: string, boundaries: number[]): ViewOptions {
  return {
    instrumentName,
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries },
    },
  };
}

// The SDK's default buckets stop at 10 000, too low for these milliseconds,
// and start at 5, far above a turn's cost in USD.
const VIEWS: ViewOptions[] = [
  // The model thinks before it speaks, and a tool call can come first.
  buckets(
    'mate_turn_first_token_milliseconds',
    [250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000],
  ),
  buckets('mate_turn_cost_usd', COST_BOUNDARIES),
  buckets('mate_mint_duration_milliseconds', MINT_BOUNDARIES),
  buckets('mate_exec_open_milliseconds', CONNECT_BOUNDARIES),
  buckets('mate_hands_connect_milliseconds', CONNECT_BOUNDARIES),
  buckets('mate_hands_call_milliseconds', HANDS_CALL_BOUNDARIES),
];

type Env = Record<string, string | undefined>;

let provider: MeterProvider | null = null;

/** The collector's OTLP/HTTP base, or `null` for "export nothing". */
export function otlpEndpoint(env: Env): string | null {
  const raw =
    env.MATE_OTEL_ENDPOINT?.trim() || env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

/** True when a MeterProvider is now registered, so instruments are real. */
export function startTelemetry(env: Env, log: Log): boolean {
  if (provider) return true;
  const endpoint = otlpEndpoint(env);
  if (!endpoint) {
    log.info('metrics are inert; no OTLP endpoint configured');
    return false;
  }
  provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    views: VIEWS,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${endpoint}/v1/metrics`,
          timeoutMillis: EXPORT_TIMEOUT_MS,
        }),
        exportIntervalMillis: EXPORT_INTERVAL_MS,
      }),
    ],
  });
  metrics.setGlobalMeterProvider(provider);
  log.info('metrics exporting', { endpoint, intervalMs: EXPORT_INTERVAL_MS });
  return true;
}

/** Flushes and unregisters; safe to call when nothing was ever started. */
export async function stopTelemetry(): Promise<void> {
  const current = provider;
  provider = null;
  if (!current) return;
  metrics.disable();
  await current.shutdown();
}
