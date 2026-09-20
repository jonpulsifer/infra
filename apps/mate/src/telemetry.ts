/**
 * The metrics SDK, and the only thing in mate that registers one.
 *
 * `metrics.ts` mints nothing until an instrument is first used, so the single
 * rule this file exists to keep is that `startTelemetry` runs before the first
 * thread transition: an OpenTelemetry instrument minted before a
 * MeterProvider is registered stays a no-op for the life of the process and
 * never says so.
 *
 * With no endpoint configured nothing is registered at all — the API's global
 * meter stays the no-op one and every record is a cheap nothing. That is what
 * `bun test` and a workstation run get, and it is why neither needs a
 * collector.
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

/**
 * `service.name` and nothing else. The collector's prometheus exporter turns
 * it into the `exported_job` label and would turn a `service.instance.id`
 * into a second one — which would give every pod its own series and make
 * `increase()` across a roll read as a fresh counter instead of a reset.
 */
export const SERVICE_NAME = 'mate';

export const EXPORT_INTERVAL_MS = 15_000;
export const EXPORT_TIMEOUT_MS = 5_000;

/**
 * Getting a thread a sandbox is the one thing here measured in minutes: the
 * mint waits on a kata VM booting and an image landing, and gives up at
 * `READY_TIMEOUT_MS`, five minutes. Both steps share these boundaries so a
 * mint and the attach behind it read off one axis, and the top one is that
 * timeout — a sample can reach it, and anything past it is a mint that never
 * happened.
 */
const SANDBOX_BOUNDARIES = [
  1_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];

/**
 * The SDK's default buckets stop at 10 000, which is fine for milliseconds
 * only if nothing takes longer than ten seconds — the first measured round
 * trip took 7.65 s to its first token, so every real sample would pile into
 * the last two buckets. The cost histogram is worse: a turn measured
 * $0.002178, and the default boundaries start at 5.
 */
const VIEWS: ViewOptions[] = [
  {
    instrumentName: 'mate_turn_first_token_milliseconds',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [250, 500, 1_000, 2_500, 5_000, 10_000, 30_000] },
    },
  },
  {
    instrumentName: 'mate_turn_cost_usd',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1] },
    },
  },
  {
    instrumentName: 'mate_mint_duration_milliseconds',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: SANDBOX_BOUNDARIES },
    },
  },
  {
    instrumentName: 'mate_attach_duration_milliseconds',
    aggregation: {
      type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      options: { boundaries: SANDBOX_BOUNDARIES },
    },
  },
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
