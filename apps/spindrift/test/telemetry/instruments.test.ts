import { expect, test } from 'bun:test';
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { reconcilerLoopCounter } from '../../src/telemetry/index.ts';

/**
 * The metrics API has no proxy provider, so an instrument minted before a
 * MeterProvider is registered has to re-mint once one is.
 */
test('an instrument minted before a provider records once one is registered', async () => {
  // Restore the suite's provider afterwards, or leave the slot empty if there
  // was none, so a later `initTelemetry` can still register.
  const previous = metrics.getMeterProvider();
  metrics.disable();
  const unregistered = metrics.getMeterProvider();

  const exporter = new InMemoryMetricExporter(
    AggregationTemporality.CUMULATIVE,
  );
  const reader = new PeriodicExportingMetricReader({
    exporter,
    // Long enough that the `forceFlush` below is the only collection.
    exportIntervalMillis: 600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });

  try {
    reconcilerLoopCounter.add(1);

    expect(metrics.setGlobalMeterProvider(provider)).toBe(true);
    reconcilerLoopCounter.add(2);
    await reader.forceFlush();

    const exported = exporter
      .getMetrics()
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === 'reconciler_loop_total');

    if (exported?.dataPointType !== DataPointType.SUM) {
      throw new Error('reconciler_loop_total exported no sum');
    }
    // 2, not 3: the add before registration went to the no-op and is gone.
    expect(exported.dataPoints.map((point) => point.value)).toEqual([2]);
  } finally {
    await provider.shutdown();
    metrics.disable();
    if (previous !== unregistered) {
      metrics.setGlobalMeterProvider(previous);
    }
  }
});
