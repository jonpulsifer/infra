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

  // Rolling window the per-metric highs and lows are taken over.
  HISTORY_WINDOW: 24 * 60 * 60, // seconds

  // History is a full 24h refetch per device (~1440 one-minute rows), so it
  // runs far less often than the latest-observation poll. Highs and lows move
  // slowly; being up to 5 minutes behind on them is invisible.
  HISTORY_INTERVAL: 5 * 60_000, // ms
  HISTORY_TIMEOUT: 20_000, // ms - a day of samples is a much larger response

  // Points in the downsampled temperature series sent to clients. 24h over 96
  // buckets is one point per 15 minutes: enough shape for a sparkline drawn
  // 370px wide, small enough to keep the snapshot a few KB.
  HISTORY_POINTS: 96,
} as const;
