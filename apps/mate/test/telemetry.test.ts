import { describe, expect, test } from 'bun:test';
import { FATAL_CLOSE_CODES } from '../src/gateway.ts';
import { silentLog } from '../src/log.ts';
import { getInstruments } from '../src/metrics.ts';
import {
  ATTACH_BOUNDARIES,
  MINT_BOUNDARIES,
  otlpEndpoint,
  startTelemetry,
  stopTelemetry,
} from '../src/telemetry.ts';

/** The histogram bucket bounds as sent on the wire. */
function boundsOf(body: string, metric: string): number[] {
  const payload = JSON.parse(body) as {
    resourceMetrics: {
      scopeMetrics: {
        metrics: {
          name: string;
          histogram?: { dataPoints: { explicitBounds: number[] }[] };
        }[];
      }[];
    }[];
  };
  return (
    payload.resourceMetrics
      .flatMap((resource) => resource.scopeMetrics)
      .flatMap((scope) => scope.metrics)
      .find((one) => one.name === metric)?.histogram?.dataPoints[0]
      ?.explicitBounds ?? []
  );
}

describe('the OTLP endpoint', () => {
  test('mate keeps its own name and falls back to the standard one', () => {
    expect(otlpEndpoint({ MATE_OTEL_ENDPOINT: 'http://a:4318' })).toBe(
      'http://a:4318',
    );
    expect(otlpEndpoint({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://b:4318' })).toBe(
      'http://b:4318',
    );
    expect(
      otlpEndpoint({
        MATE_OTEL_ENDPOINT: 'http://a:4318',
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://b:4318',
      }),
    ).toBe('http://a:4318');
  });

  test('a trailing slash is dropped, so the signal path is never doubled', () => {
    expect(otlpEndpoint({ MATE_OTEL_ENDPOINT: 'http://a:4318//' })).toBe(
      'http://a:4318',
    );
  });

  test('unset or blank is no endpoint at all', () => {
    expect(otlpEndpoint({})).toBeNull();
    expect(otlpEndpoint({ MATE_OTEL_ENDPOINT: '   ' })).toBeNull();
  });
});

describe('the SDK', () => {
  test('registers nothing without an endpoint, so a test run exports nothing', async () => {
    expect(startTelemetry({}, silentLog)).toBe(false);
    // Idempotent and safe with nothing started: the exit path calls it blind.
    await stopTelemetry();
  });

  test('an instrument minted after the SDK reaches the collector, and the exit flushes it', async () => {
    const bodies: string[] = [];
    const collector = Bun.serve({
      port: 0,
      fetch: async (request) => {
        bodies.push(await request.text());
        return new Response(null, { status: 200 });
      },
    });
    try {
      // Minted before the SDK starts: the metrics API has no re-binding proxy,
      // so getInstruments must re-mint once the provider changes.
      getInstruments().turnStarted();
      expect(
        startTelemetry(
          { MATE_OTEL_ENDPOINT: `http://localhost:${collector.port}` },
          silentLog,
        ),
      ).toBe(true);
      getInstruments().gatewayClosed(4004, true);
      getInstruments().minted('ok', {
        source: 'fresh',
        mintMs: 42_000,
        attachMs: 420,
      });
      // The exit flush carries the last counters out before the 15 s export interval.
      await stopTelemetry();
    } finally {
      collector.stop(true);
    }

    expect(bodies).toHaveLength(1);
    const sent = bodies[0] ?? '';
    expect(sent).toContain('mate_gateway_closes_total');
    expect(sent).toContain('4004');
    // The collector's Prometheus exporter leaves names in this form alone.
    expect(sent).toContain('mate_mint_duration_milliseconds');
    expect(sent).toContain('mate_attach_duration_milliseconds');
    // The resource attribute the collector turns into the `exported_job` label.
    expect(sent).toContain('service.name');
    // Without these views the SDK's default buckets stop at 10 000 ms, below the mint above.
    expect(boundsOf(sent, 'mate_mint_duration_milliseconds')).toEqual([
      ...MINT_BOUNDARIES,
    ]);
    expect(boundsOf(sent, 'mate_attach_duration_milliseconds')).toEqual([
      ...ATTACH_BOUNDARIES,
    ]);
  });
});

describe('the fatal close codes', () => {
  test('are exactly the ones the PrometheusRule calls configuration errors', () => {
    // The alert matches `fatal="true"`, but its description names these codes.
    expect([...FATAL_CLOSE_CODES].sort((a, b) => a - b)).toEqual([
      4004, 4010, 4011, 4012, 4013, 4014,
    ]);
  });
});
