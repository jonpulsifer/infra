/**
 * The seam between mate and a collector: where the endpoint comes from, that
 * an unset one leaves everything inert, and that the close codes the alert
 * names are the ones the process actually treats as fatal.
 */
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

/** The bucket layout the exporter actually put on the wire for one histogram. */
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
      // Deliberately out of order: this mints against the no-op provider, and
      // everything after it has to survive that. The metrics API keeps no
      // proxy that re-binds on registration, so without the re-mint in
      // getInstruments this one call would silence the process for good.
      getInstruments().turnStarted();
      expect(
        startTelemetry(
          { MATE_OTEL_ENDPOINT: `http://localhost:${collector.port}` },
          silentLog,
        ),
      ).toBe(true);
      // Minted only now, which is the whole contract: an instrument built
      // before the line above would be a no-op and say nothing about it.
      getInstruments().gatewayClosed(4004, true);
      getInstruments().minted('ok', {
        source: 'fresh',
        mintMs: 42_000,
        attachMs: 420,
      });
      // Nothing waits for the 15s export interval — the exit path's flush is
      // what has to carry the last counter out, and this is that path.
      await stopTelemetry();
    } finally {
      collector.stop(true);
    }

    expect(bodies).toHaveLength(1);
    const sent = bodies[0] ?? '';
    expect(sent).toContain('mate_gateway_closes_total');
    expect(sent).toContain('4004');
    // Spelled the way an alert or a dashboard query has to spell them, which
    // is the only spelling the collector's prometheus exporter leaves alone.
    expect(sent).toContain('mate_mint_duration_milliseconds');
    expect(sent).toContain('mate_attach_duration_milliseconds');
    // The resource attribute the collector turns into the `exported_job` label.
    expect(sent).toContain('service.name');
    // A view is only observable on the wire. Without these two the SDK's own
    // boundaries apply, and they stop at 10 000 ms — under the mint recorded
    // above, and under an attach that is running out of harness timeout.
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
    // clusters/offsite/monitoring/mate-rules.yaml reads `fatal="true"` rather
    // than this list, so the two cannot drift — this asserts the list itself,
    // which is what the alert's description names to the operator.
    expect([...FATAL_CLOSE_CODES].sort((a, b) => a - b)).toEqual([
      4004, 4010, 4011, 4012, 4013, 4014,
    ]);
  });
});
