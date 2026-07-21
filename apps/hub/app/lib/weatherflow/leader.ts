// Pure "who leads each metric" computation for the station-card comparison.
// Replaces the old dedicated difference column: instead of a numeric delta, the
// UI highlights the station holding the extreme (highest) value per metric.
import type { StationObservation } from './types';

// Metric fields with a meaningful leader (the highest reading). Wind direction
// is excluded — a compass bearing has no max. Feels-like / timestamp aren't
// compared either.
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
// from the map when fewer than two stations report it, or the maximum is tied —
// in both cases there's nothing to single out.
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

    // Only mark a leader when it actually beat at least one other station.
    if (reporters >= 2 && bestIndex >= 0 && !tied) {
      leaders[field] = bestIndex;
    }
  }

  return leaders;
}
