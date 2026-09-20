// Shared types for the WeatherFlow Tempest REST API and the /api/weather snapshot.

export type BarometricTrend = 'rising' | 'falling' | 'steady';

export type StationObservation = {
  timestamp?: number; // epoch seconds of the observation
  temperature?: number; // C
  feelsLike?: number; // C
  humidity?: number; // %
  pressure?: number; // mb
  barometricTrend?: BarometricTrend;
  windSpeed?: number; // Wind Avg (m/s)
  windLull?: number; // m/s
  windGust?: number; // m/s
  windDirection?: number; // degrees
  uvIndex?: number;
  solarRadiation?: number; // W/m^2
  illuminance?: number; // Lux
  rainTotal?: number; // Local daily rain accumulation (mm)
};

// Metrics the 24h window tracks a low and a high for. Wind direction has no
// meaningful extreme (a compass bearing doesn't order) and rain is an
// accumulation rather than an instantaneous reading, so both sit outside.
// Feels-like is absent too: the REST API derives it for the latest observation
// only, and the raw device rows history is built from never carry it.
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
  // Downsampled temperature series for the sparkline: [epoch seconds, C].
  temperature: Array<[number, number]>;
  rainTotal?: number; // mm accumulated across the window
};

export type StationSnapshot = {
  stationId: number;
  name: string;
  observation: StationObservation | null;
  updatedAt: number | null; // ms epoch of the last successful poll
  // Rolling 24h window, refreshed on its own slower cadence. Absent until the
  // first history fetch lands, and left in place when a later one fails.
  history?: StationHistory;
  error?: string; // set when the most recent poll for this station failed
};

export type WeatherSnapshot = {
  stations: StationSnapshot[];
  // User-actionable configuration problem (missing/rejected token). Transient
  // poll failures are per-station errors instead - the poller retries those.
  configError?: string;
  generatedAt: number; // ms epoch
  // Server bundle's build ID. Kiosk clients reload when it no longer matches
  // their own, so long-running displays pick up new deployments.
  buildId: string;
};

// Minimal shapes of the three REST responses the poller consumes.

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

// GET /observations/device/{id}?time_start&time_end. Each row is a positional
// array whose field order is fixed by `type` - see OBS_LAYOUTS in
// weather.server.ts for the index maps.
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
