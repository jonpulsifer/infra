// Pure diff computation for comparing two weather stations.
//
// Deepens what used to be a large inline object literal in dashboard.tsx:
// callers pass two WeatherData readings and get back a StationDiff with one
// nullish-safe subtraction per field, computed the same way every time.
import type { WeatherData } from './types';

export type StationDiff = {
  temperature?: number;
  humidity?: number;
  windSpeed?: number; // m/s - StationDisplay/MetricRow convert to km/h for display
  windLull?: number; // m/s
  windGust?: number; // m/s
  pressure?: number;
  uvIndex?: number;
  solarRadiation?: number;
  illuminance?: number;
  rainTotal?: number;
};

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
 * weather data. A field is only populated in the result when both stations
 * report a value for it; otherwise it's left undefined so callers render a
 * placeholder instead of a misleading zero.
 */
export function diffStations(
  left: WeatherData,
  right: WeatherData,
): StationDiff {
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
