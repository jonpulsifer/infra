// Development-only mock weather. Every reference is guarded behind
// `import.meta.env.DEV` in use-weather.ts, so this module is tree-shaken out of
// production bundles — it never ships to a real display.
import type {
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

// A slowly-varying 0..1 wave, distinct per (seed, phase). Time-based rather than
// random so values drift smoothly between polls (no flicker) and the highlighted
// leaders shift over a few minutes — enough to see the UI react while iterating.
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

export function mockStation(seed: number, now: number): StationSnapshot {
  return {
    stationId: 90_000 + seed,
    name: MOCK_NAMES[seed % MOCK_NAMES.length],
    observation: mockObservation(seed, now),
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
