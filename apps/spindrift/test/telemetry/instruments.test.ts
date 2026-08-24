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
 * The metrics API has no proxy provider — trace and logs each keep one — so an
 * instrument minted before a MeterProvider is registered used to stay a no-op
 * for the life of the process. Silently: `initTelemetry` still logged success
 * and traces and logs still flowed. Both entrypoints import `initTelemetry`
 * from the telemetry module, so the module body always evaluated first, so
 * every Spindrift metric was dead and every alert reading one could not fire.
 *
 * This drives the registration through the same global the entrypoints use,
 * rather than through the module's import order, so it holds wherever in the
 * suite it runs — by which point some other file has usually started a
 * reconciler and registered a provider of its own.
 */
test('an instrument minted before a provider records once one is registered', async () => {
  // Whatever the suite left registered — usually a real provider, because some
  // earlier file started a reconciler. Put it back on the way out, and put
  // nothing back if there was nothing, so a later `initTelemetry` still wins
  // the slot.
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
    // Against the no-op provider: nowhere to land, and no error either.
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
    // What this asserts is that the instrument re-minted rather than staying
    // the no-op it was born as.
    expect(exported.dataPoints.map((point) => point.value)).toEqual([2]);
  } finally {
    await provider.shutdown();
    metrics.disable();
    if (previous !== unregistered) {
      metrics.setGlobalMeterProvider(previous);
    }
  }
});
