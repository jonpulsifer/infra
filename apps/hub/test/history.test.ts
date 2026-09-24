import { describe, expect, test } from 'bun:test';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import {
  buildHistory,
  decodeDeviceObs,
  type HistorySample,
} from '~/lib/weatherflow/history';

const NOW = 1_789_862_400_000; // ms
const NOW_SECONDS = NOW / 1000;

// One obs_st row as the API documents it. The indices are under test: reading
// temperature from the pressure slot gives a 1017-degree high.
function tempestRow(at: number, temperature: number): Array<number | null> {
  return [
    at, // 0 timestamp
    0.4, // 1 wind lull
    1.2, // 2 wind avg
    2.6, // 3 wind gust
    51, // 4 wind direction
    3, // 5 wind sample interval
    1017.3, // 6 pressure
    temperature, // 7 air temperature
    95, // 8 relative humidity
    120, // 9 illuminance
    0.4, // 10 UV
    88, // 11 solar radiation
    0.2, // 12 rain accumulation this interval
    1, // 13 precipitation type
    0, // 14 lightning average distance
    0, // 15 lightning strike count
    2.7, // 16 battery
    1, // 17 reporting interval
    3.5, // 18 local day rain accumulation
  ];
}

describe('decodeDeviceObs', () => {
  test('reads Tempest rows at their documented indices', () => {
    const [sample] = decodeDeviceObs({
      type: 'obs_st',
      obs: [tempestRow(NOW_SECONDS, 6.2)],
    });

    expect(sample).toEqual({
      timestamp: NOW_SECONDS,
      windSpeed: 1.2,
      windGust: 2.6,
      pressure: 1017.3,
      temperature: 6.2,
      humidity: 95,
      illuminance: 120,
      uvIndex: 0.4,
      solarRadiation: 88,
      rainAccum: 0.2,
    });
  });

  test('reads AIR and SKY rows, which split the metrics between them', () => {
    const [air] = decodeDeviceObs({
      type: 'obs_air',
      obs: [[NOW_SECONDS, 1014.2, 9.2, 81, 0, 0, 3.4, 1]],
    });
    expect(air).toEqual({
      timestamp: NOW_SECONDS,
      pressure: 1014.2,
      temperature: 9.2,
      humidity: 81,
    });

    const [sky] = decodeDeviceObs({
      type: 'obs_sky',
      obs: [[NOW_SECONDS, 9000, 3.1, 0.5, 0.2, 1.8, 4.4, 200, 3.3, 1, 640]],
    });
    expect(sky).toEqual({
      timestamp: NOW_SECONDS,
      illuminance: 9000,
      uvIndex: 3.1,
      rainAccum: 0.5,
      windSpeed: 1.8,
      windGust: 4.4,
      solarRadiation: 640,
    });
  });

  test('yields nothing for a record format it does not know', () => {
    expect(decodeDeviceObs({ type: 'obs_future', obs: [[1, 2, 3]] })).toEqual(
      [],
    );
    expect(decodeDeviceObs({})).toEqual([]);
  });

  test('skips absent readings rather than recording them as zero', () => {
    const row = tempestRow(NOW_SECONDS, 6.2);
    row[7] = null;
    const [sample] = decodeDeviceObs({ type: 'obs_st', obs: [row] });
    expect(sample.temperature).toBeUndefined();
    expect(sample.humidity).toBe(95);
  });
});

describe('buildHistory', () => {
  // A day of one-minute samples, warm in the afternoon and coldest near dawn.
  function day(): HistorySample[] {
    const samples: HistorySample[] = [];
    for (let minute = 0; minute < 24 * 60; minute++) {
      const at = NOW_SECONDS - (24 * 60 - minute) * 60;
      const hour = minute / 60;
      samples.push({
        timestamp: at,
        temperature: 12 - 6 * Math.cos((hour / 24) * 2 * Math.PI),
        humidity: 70,
        rainAccum: 0.01,
      });
    }
    return samples;
  }

  test('records each metric extreme with the time it happened', () => {
    const history = buildHistory(day(), NOW);
    const temperature = history?.extremes.temperature;

    expect(temperature).toBeDefined();
    expect(temperature?.min).toBeCloseTo(6, 5);
    expect(temperature?.max).toBeCloseTo(18, 1);
    expect(temperature?.minAt).toBeLessThan(temperature?.maxAt ?? 0);
    // A metric that never varies still has a low and a high.
    expect(history?.extremes.humidity).toMatchObject({ min: 70, max: 70 });
  });

  test('accumulates rain across the window rather than taking a last value', () => {
    expect(buildHistory(day(), NOW)?.rainTotal).toBeCloseTo(14.4, 1);
  });

  test('drops samples older than the window', () => {
    const stale: HistorySample = {
      timestamp: NOW_SECONDS - WEATHERFLOW_CONFIG.HISTORY_WINDOW - 3600,
      temperature: -40,
    };
    const history = buildHistory([stale, ...day()], NOW);
    expect(history?.extremes.temperature?.min).toBeGreaterThan(0);
  });

  test('downsamples the series but still touches its own low and high', () => {
    const history = buildHistory(day(), NOW);
    const series = history?.temperature ?? [];
    const values = series.map(([, value]) => value);

    expect(series.length).toBeLessThanOrEqual(
      WEATHERFLOW_CONFIG.HISTORY_POINTS,
    );
    expect(series.length).toBeGreaterThan(40);
    // Averaging alone would clip both ends short of the extremes the panel prints.
    expect(Math.min(...values)).toBeCloseTo(
      history?.extremes.temperature?.min ?? 0,
      1,
    );
    expect(Math.max(...values)).toBeCloseTo(
      history?.extremes.temperature?.max ?? 0,
      1,
    );
    // Oldest first, so the sparkline reads left to right.
    expect(series[0][0]).toBeLessThan(series[series.length - 1][0]);
  });

  test('returns nothing when no sample falls inside the window', () => {
    expect(buildHistory([], NOW)).toBeUndefined();
    expect(
      buildHistory([{ timestamp: NOW_SECONDS - 90_000, temperature: 5 }], NOW),
    ).toBeUndefined();
  });
});
