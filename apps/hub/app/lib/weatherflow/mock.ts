// Mock weather for dev builds. use-weather.ts guards every use behind
// `import.meta.env.DEV`, so production bundles drop it.
import { WEATHERFLOW_CONFIG } from './config';
import type {
  HistoryField,
  MetricExtremes,
  StationHistory,
  StationObservation,
  StationSnapshot,
  WeatherSnapshot,
} from './types';

const MOCK_NAMES = [
  'Folly Mountain',
  'Old School Rd',
  'Harbourview',
  'Ridgeline',
  'Meadowbrook',
  'Cape Breton',
  'Sunset Point',
  'Riverbend',
];

// A slow 0..1 wave per (seed, phase). It follows the clock, so values drift
// between polls without flicker.
function wave(seed: number, phase: number, now: number): number {
  return (Math.sin(now / 120_000 + seed * 2.3 + phase) + 1) / 2;
}

const round = (n: number, decimals = 1): number => Number(n.toFixed(decimals));

export function mockObservation(seed: number, now: number): StationObservation {
  const warmth = wave(seed, 0, now);
  const breeze = wave(seed, 1.1, now);
  const damp = wave(seed, 2.2, now);
  const sun = wave(seed, 3.3, now);
  const windAvg = round(breeze * 6, 1); // m/s

  return {
    timestamp: Math.floor(now / 1000),
    temperature: round(4 + seed * 1.5 + warmth * 12, 1),
    feelsLike: round(4 + seed * 1.5 + warmth * 12 - breeze * 2.5, 1),
    humidity: Math.round(52 + damp * 43),
    pressure: Math.round(1004 + seed + warmth * 12),
    barometricTrend:
      warmth > 0.62 ? 'rising' : warmth < 0.38 ? 'falling' : 'steady',
    windSpeed: windAvg,
    windLull: round(Math.max(0, windAvg - 0.4), 1),
    windGust: round(windAvg + 1 + breeze, 1),
    windDirection: Math.round(wave(seed, 4.4, now) * 359),
    uvIndex: round(sun * 8, 1),
    solarRadiation: Math.round(sun * 900),
    illuminance: Math.round(sun * 100_000),
    rainTotal: round(Math.max(0, (damp - 0.72) * 14), 1),
  };
}

// Each range is a little wider than mockObservation can produce, so the
// range-bar marker never pins to an end.
function mockExtremes(
  min: number,
  max: number,
  now: number,
  lowHour: number,
  highHour: number,
): MetricExtremes {
  const midnight = Math.floor(now / 1000) - 24 * 3600;
  return {
    min,
    minAt: midnight + lowHour * 3600,
    max,
    maxAt: midnight + highHour * 3600,
  };
}

/** A diurnal temperature curve plus a low and a high per metric. */
export function mockHistory(seed: number, now: number): StationHistory {
  const base = 3 + seed * 1.5;
  const peak = 17 + seed * 1.5;
  const to = Math.floor(now / 1000);
  const from = to - WEATHERFLOW_CONFIG.HISTORY_WINDOW;
  const points = WEATHERFLOW_CONFIG.HISTORY_POINTS;
  const step = WEATHERFLOW_CONFIG.HISTORY_WINDOW / points;

  const temperature: Array<[number, number]> = [];
  for (let i = 0; i < points; i++) {
    const at = Math.round(from + (i + 0.5) * step);
    // Coldest a little before dawn, warmest mid-afternoon.
    const hour = ((at / 3600) % 24) + 24;
    const curve = (Math.cos(((hour - 15) / 24) * 2 * Math.PI) + 1) / 2;
    temperature.push([at, round(base + curve * (peak - base), 1)]);
  }

  const extremes: Partial<Record<HistoryField, MetricExtremes>> = {
    temperature: mockExtremes(base, peak, now, 5, 15),
    humidity: mockExtremes(45, 98, now, 15, 5),
    pressure: mockExtremes(1002 + seed, 1018 + seed, now, 9, 21),
    windSpeed: mockExtremes(0, 7, now, 4, 14),
    windGust: mockExtremes(0, 9.5, now, 4, 14),
    uvIndex: mockExtremes(0, 8.5, now, 0, 13),
    solarRadiation: mockExtremes(0, 950, now, 0, 13),
    illuminance: mockExtremes(0, 105_000, now, 0, 13),
  };

  return {
    from,
    to,
    samples: 24 * 60,
    extremes,
    temperature,
    rainTotal: round(Math.max(0, (wave(seed, 2.2, now) - 0.6) * 9), 1),
  };
}

export function mockStation(seed: number, now: number): StationSnapshot {
  return {
    stationId: 90_000 + seed,
    name: MOCK_NAMES[seed % MOCK_NAMES.length],
    observation: mockObservation(seed, now),
    history: mockHistory(seed, now),
    updatedAt: now,
  };
}

export function mockSnapshot(seeds: number[], now: number): WeatherSnapshot {
  return {
    stations: seeds.map((seed) => mockStation(seed, now)),
    generatedAt: now,
    buildId: __BUILD_ID__,
  };
}
