import { describe, expect, test } from 'bun:test';
import { parseBurnSafe } from '../src/burnsafe.ts';
import { distanceKm, localTime, parsePoint, zoneForCity } from '../src/geo.ts';
import { localize } from '../src/operations.ts';
import { parsePlaces } from '../src/places.ts';
import { decode, summarize } from '../src/tempest.ts';
import { Upstream } from '../src/upstream.ts';

describe('geo', () => {
  test('parses lat,lon and refuses anything else', () => {
    expect(parsePoint('45.363, -63.276')).toEqual({
      lat: 45.363,
      lon: -63.276,
    });
    expect(parsePoint('Truro')).toBeNull();
    expect(parsePoint('95,-63')).toBeNull();
  });

  test('measures Debert to Halifax', () => {
    const km = distanceKm(
      { lat: 45.363, lon: -63.276 },
      { lat: 44.649, lon: -63.602 },
    );
    expect(km).toBeGreaterThan(80);
    expect(km).toBeLessThan(90);
  });

  test('labels an instant in the place zone', () => {
    expect(localTime('2026-09-29T22:00:00Z', 'America/Halifax')).toBe(
      '2026-09-29 19:00 ADT',
    );
    expect(zoneForCity('ab-63')).toBe('America/Edmonton');
  });

  test('localize rewrites UTC timestamps and nothing else', () => {
    expect(
      localize(
        {
          at: '2026-09-29T22:00:00Z',
          name: 'Truro',
          list: ['2026-09-29T22:00Z'],
        },
        'America/Halifax',
      ),
    ).toEqual({
      at: '2026-09-29 19:00 ADT',
      name: 'Truro',
      list: ['2026-09-29 19:00 ADT'],
    });
  });
});

describe('places', () => {
  test('keeps the configured order, home first', () => {
    expect(
      parsePlaces('Debert=45.363,-63.276; halifax=44.649,-63.602').map(
        (p) => p.name,
      ),
    ).toEqual(['debert', 'halifax']);
  });

  test('rejects an entry without coordinates', () => {
    expect(() => parsePlaces('debert=home')).toThrow('name=lat,lon');
  });
});

describe('burnsafe', () => {
  test('reads each county row and the update time', () => {
    const html = `<p>Last updated: 29 September 2026 at 2:00 pm</p>
      <tr id="Colchester-County"><td>Colchester</td><td class="status-burn"><p>2 pm</p></td></tr>
      <tr id="Cape-Breton-County"><td>x</td><td class="status-no-burn"><p>No burning</p></td></tr>`;
    expect(parseBurnSafe(html)).toMatchObject({
      updated: '29 September 2026 at 2:00 pm',
      counties: [
        { county: 'Colchester', level: 'burn' },
        { county: 'Cape Breton', level: 'no-burn', rule: 'No burning' },
      ],
    });
  });
});

describe('tempest history', () => {
  const t0 = Date.UTC(2026, 8, 29, 22, 0) / 1000;
  const row = (t: number, temp: number, gustMs: number, rain: number) => [
    t,
    0,
    1,
    gustMs,
    180,
    3,
    1000,
    temp,
    90,
    0,
    0,
    0,
    rain,
    0,
    0,
    2,
  ];

  test('buckets by local hour with rain summed and gusts in km/h', () => {
    const samples = decode({
      type: 'obs_st',
      obs: [
        row(t0, 16, 10, 0.5),
        row(t0 + 60, 18, 5, 0.25),
        row(t0 + 3600, 15, 1, 0),
      ],
    });
    const buckets = summarize(samples, 'America/Halifax', false);
    expect(buckets).toHaveLength(2);
    expect(buckets[0]).toMatchObject({
      start: '2026-09-29 19:00',
      lowC: 16,
      highC: 18,
      maxGustKmh: 36,
      rainMm: 0.75,
      lightningStrikes: 4,
    });
  });

  test('an unknown record type yields no samples', () => {
    expect(decode({ type: 'obs_new', obs: [[t0, 1]] })).toEqual([]);
  });
});

describe('upstream cache', () => {
  test('serves a hit until it expires and never caches a failure', async () => {
    let now = 0;
    let calls = 0;
    const upstream = new Upstream(
      async () => {
        calls += 1;
        return calls === 2
          ? new Response('nope', { status: 503 })
          : Response.json({ calls });
      },
      () => now,
    );
    expect(
      await upstream.json<{ calls: number }>('https://x.test/a', 1000),
    ).toEqual({ calls: 1 });
    expect(
      await upstream.json<{ calls: number }>('https://x.test/a', 1000),
    ).toEqual({ calls: 1 });
    now = 2000;
    await expect(
      upstream.json<{ calls: number }>('https://x.test/a', 1000),
    ).rejects.toThrow('x.test answered HTTP 503');
    expect(
      await upstream.json<{ calls: number }>('https://x.test/a', 1000),
    ).toEqual({ calls: 3 });
  });
});
