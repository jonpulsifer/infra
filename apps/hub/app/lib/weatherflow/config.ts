// Configuration constants for the WeatherFlow REST API poller.

export const WEATHERFLOW_CONFIG = {
  REST_API_URL: 'https://swd.weatherflow.com/swd/rest',
  API_TIMEOUT: 10_000, // ms

  // Stations report a new observation roughly once a minute; polling twice as
  // often keeps the display at most ~30s behind without hammering the API.
  POLL_INTERVAL: 30_000, // ms

  // Comma-separated list of station IDs to ignore (TEMPESTWX_IGNORE_STATIONS).
  IGNORE_STATIONS_ENV: 'TEMPESTWX_IGNORE_STATIONS',

  // Barometric trend: change needed over the trend window to count as
  // rising/falling rather than steady.
  PRESSURE_TREND_THRESHOLD: 1.0, // mb
  PRESSURE_TREND_WINDOW: 30 * 60, // seconds
} as const;
