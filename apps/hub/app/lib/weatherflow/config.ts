// Configuration constants for WeatherFlow API

export const WEATHERFLOW_CONFIG = {
  // WebSocket configuration
  WS_URL: 'wss://ws.weatherflow.com/swd/data',
  WS_RECONNECT: {
    INITIAL_DELAY: 1000, // 1 second
    MAX_DELAY: 30000, // 30 seconds
    BACKOFF_MULTIPLIER: 2,
    // Caps how many times the backoff delay is allowed to grow before it
    // holds steady at MAX_DELAY. This is a kiosk display meant to run
    // unattended, so we never stop retrying entirely - we just stop
    // growing the delay after this many attempts.
    MAX_RETRIES: 10,
  },
  KEEPALIVE_INTERVAL: 5 * 60 * 1000, // 5 minutes
  IDLE_TIMEOUT: 10 * 60 * 1000, // 10 minutes (server-side timeout)

  // REST API configuration
  REST_API_URL: 'https://swd.weatherflow.com/swd/rest',
  API_TIMEOUT: 10000, // 10 seconds

  // Data processing thresholds
  PRESSURE_TREND_THRESHOLD: 1.0, // mb threshold for significant change
  PRESSURE_HISTORY_SIZE: 20, // Keep last 20 readings for trend calculation
  HUMIDEX_MIN_TEMP: 20, // C - humidex not applicable below this
  HUMIDEX_MIN_HUMIDITY: 40, // % - humidex not applicable below this
  FEELS_LIKE_MIN_DIFF: 2, // C - only show feels like if difference > 2
} as const;
