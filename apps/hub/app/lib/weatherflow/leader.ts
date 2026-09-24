// Which station holds the highest reading of each metric.
import type { StationObservation } from './types';

// Wind direction is excluded: a compass bearing has no maximum.
export const LEADER_FIELDS = [
  'temperature',
  'humidity',
  'pressure',
  'windSpeed',
  'windLull',
  'windGust',
  'uvIndex',
  'solarRadiation',
  'illuminance',
  'rainTotal',
] as const;

export type LeaderField = (typeof LEADER_FIELDS)[number];

// Per-field index of the station holding the unique maximum. A field is absent
// when fewer than two stations report it or the maximum is tied.
export type LeaderMap = Partial<Record<LeaderField, number>>;

export function computeLeaders(
  observations: (StationObservation | null | undefined)[],
): LeaderMap {
  const leaders: LeaderMap = {};

  for (const field of LEADER_FIELDS) {
    let bestIndex = -1;
    let bestValue = Number.NEGATIVE_INFINITY;
    let reporters = 0;
    let tied = false;

    observations.forEach((obs, index) => {
      const value = obs?.[field];
      if (value == null) return;
      reporters++;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = index;
        tied = false;
      } else if (value === bestValue) {
        tied = true;
      }
    });

    if (reporters >= 2 && bestIndex >= 0 && !tied) {
      leaders[field] = bestIndex;
    }
  }

  return leaders;
}
