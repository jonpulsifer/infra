import {
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type Tracer,
  trace,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
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

  const resource = new Resource({
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

  const logRecordProcessor = new BatchLogRecordProcessor(logExporter);

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

const logger = logs.getLogger('spindrift');

export function logInfo(message: string, attributes: Record<string, any> = {}) {
  console.log(`[INFO] ${message}`, attributes);
  try {
    logger.emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: message,
      attributes,
    });
  } catch {}
}

export function logWarn(message: string, attributes: Record<string, any> = {}) {
  console.warn(`[WARN] ${message}`, attributes);
  try {
    logger.emit({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      body: message,
      attributes,
    });
  } catch {}
}

export function logError(
  message: string,
  error?: unknown,
  attributes: Record<string, any> = {},
) {
  console.error(`[ERROR] ${message}`, error, attributes);
  try {
    logger.emit({
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
  } catch {}
}
