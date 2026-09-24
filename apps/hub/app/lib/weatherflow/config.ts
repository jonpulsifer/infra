export const WEATHERFLOW_CONFIG = {
  REST_API_URL: 'https://swd.weatherflow.com/swd/rest',
  API_TIMEOUT: 10_000, // ms

  // Stations report about once a minute; polling twice as often keeps the
  // display at most ~30 s behind.
  POLL_INTERVAL: 30_000, // ms

  // Names the env var holding comma-separated station IDs to ignore.
  IGNORE_STATIONS_ENV: 'TEMPESTWX_IGNORE_STATIONS',

  // The pressure change over the window that counts as rising or falling.
  PRESSURE_TREND_THRESHOLD: 1.0, // mb
  PRESSURE_TREND_WINDOW: 30 * 60, // seconds

  // The rolling window for per-metric highs and lows.
  HISTORY_WINDOW: 24 * 60 * 60, // seconds

  // History is a full 24 h refetch per device (~1440 rows), so it runs far less
  // often than the observation poll.
  HISTORY_INTERVAL: 5 * 60_000, // ms
  HISTORY_TIMEOUT: 20_000, // ms - a day of samples is a much larger response

  // One point per 15 minutes: enough for a sparkline, and the snapshot stays a
  // few KB.
  HISTORY_POINTS: 96,
} as const;
