import {
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterProvider,
  type MetricOptions,
  metrics,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import {
  type LogAttributes,
  logs,
  SeverityNumber,
} from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

const OTLP_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  'http://opentelemetry-collector.monitoring.svc.cluster.local:4318';
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'spindrift';
const SERVICE_VERSION = process.env.SPINDRIFT_VERSION || '1.0.0';

let sdkInstance: NodeSDK | null = null;

export function initTelemetry(component = 'web'): NodeSDK | null {
  if (sdkInstance) {
    return sdkInstance;
  }

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: `${SERVICE_NAME}-${component}`,
    [ATTR_SERVICE_VERSION]: SERVICE_VERSION,
  });

  const traceExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
  });

  const metricExporter = new OTLPMetricExporter({
    url: `${OTLP_ENDPOINT}/v1/metrics`,
  });

  const logExporter = new OTLPLogExporter({
    url: `${OTLP_ENDPOINT}/v1/logs`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 10000,
  });

  const logRecordProcessor = new BatchLogRecordProcessor({
    exporter: logExporter,
  });

  sdkInstance = new NodeSDK({
    resource,
    traceExporter,
    metricReader,
    logRecordProcessor,
  });

  try {
    sdkInstance.start();
    console.log(
      `[Telemetry] OpenTelemetry initialized for ${SERVICE_NAME}-${component} -> ${OTLP_ENDPOINT}`,
    );
  } catch (error) {
    console.error('[Telemetry] Failed to initialize OpenTelemetry SDK:', error);
  }

  // A SIGTERM listener replaces the default exit and `Bun.serve` holds the loop
  // open, so exit once flushed or the pod waits out its whole grace period.
  process.on('SIGTERM', async () => {
    if (sdkInstance) {
      try {
        await sdkInstance.shutdown();
        console.log('[Telemetry] SDK shut down successfully');
      } catch (err) {
        console.error('[Telemetry] Error shutting down SDK', err);
      }
    }
    process.exit(0);
  });

  return sdkInstance;
}

export const tracer: Tracer = trace.getTracer('spindrift');

/**
 * The metrics API has no proxy provider, so an instrument minted before the SDK
 * starts stays a no-op. Each one re-mints when the global provider changes.
 */
function lazily<T>(mint: (meter: Meter) => T): () => T {
  let mintedFrom: MeterProvider | undefined;
  let instrument!: T;
  return () => {
    const provider = metrics.getMeterProvider();
    if (provider !== mintedFrom) {
      mintedFrom = provider;
      instrument = mint(provider.getMeter('spindrift'));
    }
    return instrument;
  };
}

function counter(name: string, options: MetricOptions): Counter {
  const instrument = lazily((meter) => meter.createCounter(name, options));
  return {
    add: (value, attributes, context) =>
      instrument().add(value, attributes, context),
  };
}

function histogram(name: string, options: MetricOptions): Histogram {
  const instrument = lazily((meter) => meter.createHistogram(name, options));
  return {
    record: (value, attributes, context) =>
      instrument().record(value, attributes, context),
  };
}

function gauge(name: string, options: MetricOptions): Gauge {
  const instrument = lazily((meter) => meter.createGauge(name, options));
  return {
    record: (value, attributes, context) =>
      instrument().record(value, attributes, context),
  };
}

export const httpRequestCounter: Counter = counter('http_requests_total', {
  description: 'Total number of HTTP requests received',
});

export const httpRequestDuration: Histogram = histogram(
  'http_request_duration_seconds',
  {
    description: 'HTTP request duration in seconds',
    unit: 's',
  },
);

export const reconcilerLoopCounter: Counter = counter('reconciler_loop_total', {
  description: 'Total reconciler loop executions',
});

export const reconcilerLoopDuration: Histogram = histogram(
  'reconciler_loop_duration_seconds',
  {
    description: 'Reconciler loop execution duration in seconds',
    unit: 's',
  },
);

export const reconcilerErrorCounter: Counter = counter(
  'reconciler_errors_total',
  {
    description: 'Total reconciler loop errors',
  },
);

/** Wall time of one build or deploy attempt, labelled `kind` and `outcome`. */
export const reconcilerAttemptDuration: Histogram = histogram(
  'reconciler_attempt_duration_seconds',
  {
    description: 'Duration of one build or deploy attempt',
    unit: 's',
  },
);

export const reconcilerPickupLatency: Histogram = histogram(
  'reconciler_pickup_latency_seconds',
  {
    description:
      'Time from a build or deploy row being created to the reconciler first claiming it',
    unit: 's',
  },
);

export const reconcilerQueueDepth: Gauge = gauge('reconciler_queue_depth', {
  description: 'Rows still awaiting reconciliation at the end of one pass',
});

/**
 * Labelled `outcome`: `dispatched`, `waiting` (refused, retried on backoff),
 * `closed` (refused for good) or `lost` (another replica won the claim).
 */
export const reconcilerDispatchAttempts: Counter = counter(
  'reconciler_dispatch_attempts_total',
  {
    description: 'Build dispatch attempts, labelled by outcome',
  },
);

/**
 * Labelled `call`. Once it stays at zero across every host, the outbox can
 * require a claimant without refusing anyone.
 */
export const bosunUnfencedCalls: Counter = counter(
  'bosun_unfenced_calls_total',
  {
    description: 'Bosun heartbeat/result calls that carried no claimant',
  },
);

/** As of the deploy loop's last pass that observed drift. */
export const reconcilerDriftedDeploys: Gauge = gauge(
  'reconciler_drifted_deploys',
  {
    description:
      'Live deploys whose observed artifact no longer matches what is desired',
  },
);

const logger = logs.getLogger('spindrift');

/**
 * The OTLP copy is best-effort: `console` already has the line. A failure goes
 * to stderr, never back through `logger`, which could loop.
 */
function emitSafely(record: Parameters<typeof logger.emit>[0]): void {
  try {
    logger.emit(record);
  } catch (cause) {
    console.error('[Telemetry] failed to emit log record', cause);
  }
}

export function logInfo(message: string, attributes: LogAttributes = {}) {
  console.log(`[INFO] ${message}`, attributes);
  emitSafely({
    severityNumber: SeverityNumber.INFO,
    severityText: 'INFO',
    body: message,
    attributes,
  });
}

export function logWarn(message: string, attributes: LogAttributes = {}) {
  console.warn(`[WARN] ${message}`, attributes);
  emitSafely({
    severityNumber: SeverityNumber.WARN,
    severityText: 'WARN',
    body: message,
    attributes,
  });
}

export function logError(
  message: string,
  error?: unknown,
  attributes: LogAttributes = {},
) {
  console.error(`[ERROR] ${message}`, error, attributes);
  emitSafely({
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    body: `${message}${error instanceof Error ? `: ${error.message}` : ''}`,
    attributes: {
      ...attributes,
      ...(error instanceof Error
        ? { 'error.stack': error.stack, 'error.message': error.message }
        : {}),
    },
  });
}
