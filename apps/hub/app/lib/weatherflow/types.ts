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

export type StationSnapshot = {
  stationId: number;
  name: string;
  observation: StationObservation | null;
  updatedAt: number | null; // ms epoch of the last successful poll
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

// Minimal shapes of the two REST responses the poller consumes.
export type StationsResponse = {
  stations?: Array<{
    station_id: number;
    name?: string;
    public_name?: string;
  }>;
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
