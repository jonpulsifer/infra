// Shared types for the WeatherFlow Tempest REST API and the /api/weather snapshot.

import type { BurnRestriction } from '~/lib/burnsafe';

export type BarometricTrend = 'rising' | 'falling' | 'steady';

export type StationObservation = {
  timestamp?: number; // epoch seconds
  temperature?: number; // C
  feelsLike?: number; // C
  humidity?: number; // %
  pressure?: number; // mb
  barometricTrend?: BarometricTrend;
  windSpeed?: number; // average, m/s
  windLull?: number; // m/s
  windGust?: number; // m/s
  windDirection?: number; // degrees
  uvIndex?: number;
  solarRadiation?: number; // W/m^2
  illuminance?: number; // Lux
  rainTotal?: number; // mm accumulated since local midnight
};

// Wind direction does not order and rain accumulates, so neither has extremes.
// Feels-like is absent: the API derives it for the latest observation only.
export const HISTORY_FIELDS = [
  'temperature',
  'humidity',
  'pressure',
  'windSpeed',
  'windGust',
  'uvIndex',
  'solarRadiation',
  'illuminance',
] as const;

export type HistoryField = (typeof HISTORY_FIELDS)[number];

export type MetricExtremes = {
  min: number;
  minAt: number; // epoch seconds of the lowest sample
  max: number;
  maxAt: number; // epoch seconds of the highest sample
};

export type StationHistory = {
  from: number; // epoch seconds of the oldest sample in the window
  to: number; // epoch seconds of the newest
  samples: number; // raw device observations the window was built from
  extremes: Partial<Record<HistoryField, MetricExtremes>>;
  // The downsampled sparkline series: [epoch seconds, C].
  temperature: Array<[number, number]>;
  rainTotal?: number; // mm accumulated across the window
};

export type StationSnapshot = {
  stationId: number;
  name: string;
  observation: StationObservation | null;
  updatedAt: number | null; // ms epoch of the last successful poll
  // Absent until the first history fetch arrives, and kept when a later one fails.
  history?: StationHistory;
  error?: string; // set when the most recent poll for this station failed
  // Today's burning restriction where the station stands, when BURNSAFE_COUNTIES
  // names an area for it.
  burn?: BurnRestriction;
};

export type WeatherSnapshot = {
  stations: StationSnapshot[];
  // A missing or rejected token, which the user must fix. Transient poll
  // failures are per-station errors that the poller retries.
  configError?: string;
  generatedAt: number; // ms epoch
  // Kiosks reload when this differs from their own build ID.
  buildId: string;
};

// Minimal shapes of the REST responses the poller reads.

// Device types that report outdoor weather. HB (hub) reports none.
export type WeatherDeviceType = 'ST' | 'AR' | 'SK';

export type StationsResponse = {
  stations?: Array<{
    station_id: number;
    name?: string;
    public_name?: string;
    devices?: Array<{
      device_id: number;
      device_type?: string;
    }>;
  }>;
};

// GET /observations/device/{id}?time_start&time_end. Rows are positional arrays
// ordered by `type`; OBS_LAYOUTS in history.ts maps them.
export type DeviceObsResponse = {
  type?: string; // 'obs_st' | 'obs_air' | 'obs_sky'
  obs?: Array<Array<number | null>>;
};

export type StationObsResponse = {
  obs?: Array<{
    timestamp?: number;
    air_temperature?: number;
    feels_like?: number;
    relative_humidity?: number;
    station_pressure?: number;
    barometric_pressure?: number;
    wind_avg?: number;
    wind_lull?: number;
    wind_gust?: number;
    wind_direction?: number;
    uv?: number;
    solar_radiation?: number;
    brightness?: number;
    precip_accum_local_day?: number;
  }>;
};
