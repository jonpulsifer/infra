import {
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
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

  process.on('SIGTERM', async () => {
    if (sdkInstance) {
      try {
        await sdkInstance.shutdown();
        console.log('[Telemetry] SDK shut down successfully');
      } catch (err) {
        console.error('[Telemetry] Error shutting down SDK', err);
      }
    }
  });

  return sdkInstance;
}

export const tracer: Tracer = trace.getTracer('spindrift');
export const meter: Meter = metrics.getMeter('spindrift');

export const httpRequestCounter: Counter = meter.createCounter(
  'http_requests_total',
  {
    description: 'Total number of HTTP requests received',
  },
);

export const httpRequestDuration: Histogram = meter.createHistogram(
  'http_request_duration_seconds',
  {
    description: 'HTTP request duration in seconds',
    unit: 's',
  },
);

export const reconcilerLoopCounter: Counter = meter.createCounter(
  'reconciler_loop_total',
  {
    description: 'Total reconciler loop executions',
  },
);

export const reconcilerLoopDuration: Histogram = meter.createHistogram(
  'reconciler_loop_duration_seconds',
  {
    description: 'Reconciler loop execution duration in seconds',
    unit: 's',
  },
);

export const reconcilerErrorCounter: Counter = meter.createCounter(
  'reconciler_errors_total',
  {
    description: 'Total reconciler loop errors',
  },
);

/**
 * How long one build or deploy attempt took, from dispatch to a terminal
 * outcome — recorded around the same adapter call the build and deploy loops
 * already block on, so this is real wall time and not the loop's own poll
 * interval. `kind` distinguishes 'build' from 'deploy'; `outcome` carries
 * whatever each loop already knows the attempt ended as.
 */
export const reconcilerAttemptDuration: Histogram = meter.createHistogram(
  'reconciler_attempt_duration_seconds',
  {
    description: 'Duration of one build or deploy attempt',
    unit: 's',
  },
);

/**
 * How long a build or deploy row sat before the reconciler first claimed it —
 * the wait a developer who just pressed the button actually feels.
 */
export const reconcilerPickupLatency: Histogram = meter.createHistogram(
  'reconciler_pickup_latency_seconds',
  {
    description:
      'Time from a build or deploy row being created to the reconciler first claiming it',
    unit: 's',
  },
);

/**
 * How many build or deploy rows were still unclaimed at the end of one pass.
 * A gauge, not a counter: the loop reports the level, not an increment.
 */
export const reconcilerQueueDepth: Gauge = meter.createGauge(
  'reconciler_queue_depth',
  {
    description: 'Rows still awaiting reconciliation at the end of one pass',
  },
);

/**
 * Every dispatch attempt a Build row consumes, labelled by what it ended as —
 * `dispatched`, `waiting` (refused, will retry), or `lost` (another replica
 * won the claim).
 *
 * The invoice alarm. A wedged row retried at loop cadence spent 84k signed-URL
 * mints in a day and was first noticed on a billing alert; a rising `waiting`
 * rate is the same loop, visible in telemetry instead. The per-row count lives
 * on `builds.dispatch_attempts`, so this stays free of per-row attributes.
 */
export const reconcilerDispatchAttempts: Counter = meter.createCounter(
  'reconciler_dispatch_attempts_total',
  {
    description: 'Build dispatch attempts, labelled by outcome',
  },
);

/**
 * Bosun calls that named no claim, labelled by `call` (`heartbeat`/`result`).
 *
 * The instrument that says when the tolerant window can close (ticket 129).
 * Bosun ships on each host's NixOS auto-upgrade while Spindrift ships as a
 * pinned image digest, so for some stretch after this lands there are hosts
 * still posting without a claimant and `src/storage/build-outbox.ts` serves
 * them unfenced. This counter reading zero — across every host, for long enough
 * to be sure — is the evidence that requiring a claimant would refuse nobody.
 * Guessing at that from a calendar date would be guessing at when somebody
 * else's auto-upgrade ran.
 */
export const bosunUnfencedCalls: Counter = meter.createCounter(
  'bosun_unfenced_calls_total',
  {
    description: 'Bosun heartbeat/result calls that carried no claimant',
  },
);

/**
 * How many live deploys are currently drifted from their desired artifact, as
 * of the deploy loop's last drift-observing pass (§6's "visible state").
 */
export const reconcilerDriftedDeploys: Gauge = meter.createGauge(
  'reconciler_drifted_deploys',
  {
    description:
      'Live deploys whose observed artifact no longer matches what is desired',
  },
);

const logger = logs.getLogger('spindrift');

/**
 * Emit a log record without letting a broken exporter take the caller down.
 *
 * `console.*` already ran before this is reached, so the log line itself is
 * never lost to an OTLP outage — this only guards the second, best-effort
 * copy. Reported to stderr directly rather than through `logger.emit` again,
 * which would risk looping back into the same failure.
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
