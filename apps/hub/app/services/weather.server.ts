import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { log } from '~/lib/logger';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import { WeatherMessageHandler } from '~/lib/weatherflow/message-handler';
import type {
  ListenStartMessage,
  WeatherServiceStatus,
} from '~/lib/weatherflow/types';

/**
 * Per-token connection state. WeatherFlow authenticates per-connection, so
 * each configured token gets its own WebSocket, reconnect backoff, and
 * keepalive timer - one token's connection trouble never affects another's.
 */
type StationConnection = {
  token: string;
  ws: WebSocket | null;
  isConnecting: boolean;
  reconnectAttempts: number;
  reconnectTimeout: NodeJS.Timeout | null;
  keepaliveInterval: NodeJS.Timeout | null;
  lastMessageAt: number;
};

export class WeatherService extends EventEmitter {
  private static instance: WeatherService;
  private tokens: string[] = [];
  private connections = new Map<string, StationConnection>(); // token -> connection state
  private messageHandler = new WeatherMessageHandler();
  private deviceToStation = new Map<number, string>();
  private ignoreStationIds: Set<number>;
  // Derived set: device IDs belonging to ignored stations, populated
  // in fetchAndListen and consulted in the message handler for defense
  // in depth (drops messages that arrive before/during fetchAndListen).
  private blockedDeviceIds = new Set<number>();

  private constructor() {
    super();
    // Increase max listeners for many SSE clients
    this.setMaxListeners(100);
    this.ignoreStationIds = this.parseIgnoreStations();
  }

  /**
   * Parse TEMPESTWX_IGNORE_STATIONS env var into a Set of station IDs to ignore.
   * Comma-separated list, e.g. "85191,12345". All devices belonging to an
   * ignored station are dropped.
   */
  private parseIgnoreStations(): Set<number> {
    const raw = process.env[WEATHERFLOW_CONFIG.IGNORE_STATIONS_ENV];
    if (!raw) return new Set();
    const ids = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => !isNaN(n));
    if (ids.length > 0) {
      log.info(`Ignoring station IDs: ${ids.join(', ')}`);
    }
    return new Set(ids);
  }

  public static getInstance(): WeatherService {
    if (!WeatherService.instance) {
      WeatherService.instance = new WeatherService();
    }
    return WeatherService.instance;
  }

  public setTokens(tokens: string[]) {
    const newTokens = tokens.filter((t) => !this.tokens.includes(t));
    if (newTokens.length > 0) {
      this.tokens = [...this.tokens, ...newTokens];
      // Connect every newly configured token - each gets its own WebSocket
      // since WeatherFlow auth is per-connection, not per-device.
      for (const token of newTokens) {
        this.connect(token);
      }
    }
  }

  private emitStatus(status: WeatherServiceStatus) {
    this.emit('status', status);
  }

  private getConnection(token: string): StationConnection {
    let conn = this.connections.get(token);
    if (!conn) {
      conn = {
        token,
        ws: null,
        isConnecting: false,
        reconnectAttempts: 0,
        reconnectTimeout: null,
        keepaliveInterval: null,
        lastMessageAt: 0,
      };
      this.connections.set(token, conn);
    }
    return conn;
  }

  private connect(token: string) {
    const conn = this.getConnection(token);

    if (conn.ws?.readyState === WebSocket.OPEN || conn.isConnecting) {
      return;
    }

    conn.isConnecting = true;
    const url = `${WEATHERFLOW_CONFIG.WS_URL}?token=${token}`;

    log.info('Connecting to WeatherFlow WebSocket...');

    const ws = new WebSocket(url);
    conn.ws = ws;

    ws.on('open', () => {
      log.info('WeatherFlow WebSocket connected');
      conn.isConnecting = false;
      conn.reconnectAttempts = 0;
      conn.lastMessageAt = Date.now();
      this.emitStatus({ status: 'connected' });
      this.startKeepalive(conn);

      // We don't pre-fetch devices, so we don't know which device IDs to
      // send 'listen_start' for until we've fetched this token's stations.
      this.fetchAndListen(token);
    });

    ws.on('message', (data: Buffer) => {
      conn.lastMessageAt = Date.now();
      try {
        const message = JSON.parse(data.toString());

        // Process with handler to get clean WeatherData
        const deviceId = message.device_id || 0;

        // Drop messages from devices belonging to ignored stations
        if (this.blockedDeviceIds.has(deviceId)) return;

        const stationLabel = this.deviceToStation.get(deviceId) || '';

        const weatherData = this.messageHandler.processObservation(
          message,
          deviceId,
          stationLabel,
        );

        if (weatherData) {
          this.emit('data', weatherData);
        }

        const weatherEvent = this.messageHandler.processEvent(
          message,
          deviceId,
          stationLabel,
        );
        if (weatherEvent) {
          this.emit('event', weatherEvent);
        }
      } catch (error) {
        log.error('Error processing message:', error);
      }
    });

    ws.on('close', () => {
      log.warn('WeatherFlow WebSocket closed');
      conn.isConnecting = false;
      conn.ws = null;
      this.stopKeepalive(conn);
      this.emitStatus({ status: 'disconnected' });
      this.scheduleReconnect(conn);
    });

    ws.on('error', (error: Error) => {
      log.error('WeatherFlow WebSocket error:', error);
      conn.isConnecting = false;
      // Transient connection error - the 'close' handler (which always
      // follows) schedules the reconnect. Emitted as errorKind: 'connection'
      // so the client can log/track it without flipping into the
      // user-facing error banner reserved for config problems.
      this.emitStatus({
        status: 'error',
        errorKind: 'connection',
        error: error.message,
      });
    });
  }

  /**
   * Send a WebSocket ping periodically to keep the connection alive.
   * WeatherFlow's server-side idle timeout (IDLE_TIMEOUT) closes
   * connections that go quiet; KEEPALIVE_INTERVAL is comfortably shorter
   * so we never hit it. Also acts as a watchdog: if no message (data or
   * pong) has arrived within IDLE_TIMEOUT, the socket is presumed dead and
   * force-closed so scheduleReconnect can re-establish it.
   */
  private startKeepalive(conn: StationConnection) {
    this.stopKeepalive(conn);
    conn.keepaliveInterval = setInterval(() => {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

      const idleFor = Date.now() - conn.lastMessageAt;
      if (idleFor > WEATHERFLOW_CONFIG.IDLE_TIMEOUT) {
        log.warn(
          `WeatherFlow connection idle for ${idleFor}ms, forcing reconnect`,
        );
        conn.ws.terminate();
        return;
      }

      conn.ws.ping();
    }, WEATHERFLOW_CONFIG.KEEPALIVE_INTERVAL);
  }

  private stopKeepalive(conn: StationConnection) {
    if (conn.keepaliveInterval) {
      clearInterval(conn.keepaliveInterval);
      conn.keepaliveInterval = null;
    }
  }

  private scheduleReconnect(conn: StationConnection) {
    if (conn.reconnectTimeout) return;

    const { INITIAL_DELAY, MAX_DELAY, BACKOFF_MULTIPLIER, MAX_RETRIES } =
      WEATHERFLOW_CONFIG.WS_RECONNECT;

    // Cap the exponent, not the retries: an unattended kiosk should keep
    // trying forever, just without the delay growing past MAX_DELAY.
    const exponent = Math.min(conn.reconnectAttempts, MAX_RETRIES);
    const delay = Math.min(
      INITIAL_DELAY * BACKOFF_MULTIPLIER ** exponent,
      MAX_DELAY,
    );
    conn.reconnectAttempts += 1;

    conn.reconnectTimeout = setTimeout(() => {
      conn.reconnectTimeout = null;
      this.connect(conn.token);
    }, delay);
  }

  private async fetchAndListen(token: string) {
    // We need to fetch this token's stations to learn its device IDs -
    // this is the one "prefetch" we can't avoid if we want to listen.
    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        WEATHERFLOW_CONFIG.API_TIMEOUT,
      );

      let response: Response;
      try {
        response = await fetch(
          `${WEATHERFLOW_CONFIG.REST_API_URL}/stations?token=${token}`,
          { signal: controller.signal },
        );
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const isAuthError = response.status === 401 || response.status === 403;
        log.error(
          `Failed to fetch WeatherFlow stations (HTTP ${response.status})`,
        );
        this.emitStatus({
          status: 'error',
          errorKind: isAuthError ? 'config' : 'connection',
          error: `Failed to fetch stations (HTTP ${response.status})`,
        });
        if (!isAuthError) {
          setTimeout(
            () => this.fetchAndListen(token),
            WEATHERFLOW_CONFIG.WS_RECONNECT.MAX_DELAY,
          );
        }
        return;
      }

      const data = await response.json();
      if (!data.stations) return;

      for (const station of data.stations) {
        // Skip entire station if its ID is in the ignore list
        if (this.ignoreStationIds.has(station.station_id)) {
          log.info(
            `Ignoring station ${station.station_id} (${station.name}) — in TEMPESTWX_IGNORE_STATIONS`,
          );
          // Populate blockedDeviceIds so the message handler also drops
          // any messages from these devices (defense in depth).
          if (station.devices) {
            for (const device of station.devices) {
              this.blockedDeviceIds.add(device.device_id);
            }
          }
          continue;
        }

        if (!station.devices) continue;
        for (const device of station.devices) {
          // Only listen to Tempest (ST) or Air/Sky devices, not Hubs (HB)
          if (device.device_type === 'HB') continue;

          const deviceId = device.device_id;

          this.deviceToStation.set(deviceId, station.name);

          // Emit status update so client knows about this station immediately
          this.emitStatus({
            status: 'connected',
            device_id: deviceId,
            stationLabel: station.name,
          });

          const conn = this.connections.get(token);
          if (conn?.ws?.readyState === WebSocket.OPEN) {
            const msg: ListenStartMessage = {
              type: 'listen_start',
              device_id: deviceId,
              id: Math.random().toString(),
            };
            conn.ws.send(JSON.stringify(msg));
            log.info(`Listening to device ${deviceId} (${station.name})`);
          }
        }
      }
    } catch (error) {
      log.error('Error fetching stations:', error);
      // Retry the fetch - the socket is open but we don't yet know which
      // devices to listen to, so keep trying rather than leaving it silent.
      setTimeout(
        () => this.fetchAndListen(token),
        WEATHERFLOW_CONFIG.WS_RECONNECT.MAX_DELAY,
      );
    }
  }

  public getKnownStations(): Array<{ deviceId: number; stationLabel: string }> {
    const stations: Array<{ deviceId: number; stationLabel: string }> = [];
    for (const [deviceId, stationLabel] of this.deviceToStation.entries()) {
      stations.push({ deviceId, stationLabel });
    }
    return stations;
  }
}
