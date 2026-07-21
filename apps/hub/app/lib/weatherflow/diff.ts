// Pure diff computation for comparing two weather stations.
import type { StationObservation } from './types';

/**
 * Subtract two optional numbers, returning undefined unless both sides are present.
 */
function diffField(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  return left != null && right != null ? left - right : undefined;
}

/**
 * Compute the field-by-field difference (left - right) between two stations'
 * observations. A field is only populated in the result when both stations
 * report a value for it; otherwise it's left undefined so callers render a
 * placeholder instead of a misleading zero.
 */
export function diffStations(
  left: StationObservation,
  right: StationObservation,
): StationObservation {
  return {
    temperature: diffField(left.temperature, right.temperature),
    humidity: diffField(left.humidity, right.humidity),
    windSpeed: diffField(left.windSpeed, right.windSpeed),
    windLull: diffField(left.windLull, right.windLull),
    windGust: diffField(left.windGust, right.windGust),
    pressure: diffField(left.pressure, right.pressure),
    uvIndex: diffField(left.uvIndex, right.uvIndex),
    solarRadiation: diffField(left.solarRadiation, right.solarRadiation),
    illuminance: diffField(left.illuminance, right.illuminance),
    rainTotal: diffField(left.rainTotal, right.rainTotal),
  };
}
