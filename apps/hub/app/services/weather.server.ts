import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import {
  buildHistory,
  decodeDeviceObs,
  type HistorySample,
} from '~/lib/weatherflow/history';
import type {
  BarometricTrend,
  DeviceObsResponse,
  StationHistory,
  StationObservation,
  StationObsResponse,
  StationSnapshot,
  StationsResponse,
  WeatherSnapshot,
} from '~/lib/weatherflow/types';

// Device types that report outdoor weather; a hub (HB) reports none, so
// asking it for observations only wastes a request.
const WEATHER_DEVICE_TYPES = new Set(['ST', 'AR', 'SK']);

type Station = {
  id: number;
  name: string;
  token: string;
  // Devices whose raw observations the 24h window is built from. A Tempest is
  // one device; an older station splits the metrics across an AIR and a SKY.
  deviceIds: number[];
};
type PressureSample = { t: number; p: number };

async function fetchJson<T>(
  url: string,
  timeout: number = WEATHERFLOW_CONFIG.API_TIMEOUT,
): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

function computeTrend(history: PressureSample[]): BarometricTrend {
  const cutoff = Date.now() / 1000 - WEATHERFLOW_CONFIG.PRESSURE_TREND_WINDOW;
  const recent = history.filter((s) => s.t >= cutoff);
  if (recent.length < 2) return 'steady';
  const diff = recent[recent.length - 1].p - recent[0].p;
  if (diff > WEATHERFLOW_CONFIG.PRESSURE_TREND_THRESHOLD) return 'rising';
  if (diff < -WEATHERFLOW_CONFIG.PRESSURE_TREND_THRESHOLD) return 'falling';
  return 'steady';
}

/**
 * Polls the WeatherFlow REST API for the latest observation of every station
 * reachable with the configured tokens, keeping an in-memory snapshot that
 * /api/weather serves to any number of clients. Upstream traffic is fixed at
 * one request per station per POLL_INTERVAL regardless of client count.
 */
class WeatherPoller {
  private tokens: string[];
  // Tokens whose station list we haven't successfully fetched yet; retried
  // every tick until discovery succeeds or the token is rejected as invalid.
  private undiscovered: Set<string>;
  private ignoreStationIds: Set<number>;
  private stations: Station[] = [];
  private snapshots = new Map<number, StationSnapshot>();
  private histories = new Map<number, StationHistory>();
  private pressureHistories = new Map<number, PressureSample[]>();
  private tokenErrors = new Map<string, string>();
  private firstTick: Promise<void> | null = null;

  constructor() {
    this.tokens = (process.env.TEMPESTWX_TOKENS ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    this.undiscovered = new Set(this.tokens);
    this.ignoreStationIds = new Set(
      (process.env[WEATHERFLOW_CONFIG.IGNORE_STATIONS_ENV] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter(Number.isFinite),
    );
  }

  async getSnapshot(): Promise<WeatherSnapshot> {
    if (!this.firstTick) {
      this.firstTick = this.tick();
      setInterval(() => {
        this.tick();
      }, WEATHERFLOW_CONFIG.POLL_INTERVAL);
      // History is deliberately not awaited: a day of samples per device is a
      // much larger fetch, and the first snapshot should not wait on it. The
      // panels render without a window and pick one up on a later poll.
      this.firstTick.then(() => {
        this.historyTick();
        setInterval(() => {
          this.historyTick();
        }, WEATHERFLOW_CONFIG.HISTORY_INTERVAL);
      });
    }
    await this.firstTick;
    return {
      stations: this.stations.map((s) => {
        const snapshot = this.snapshots.get(s.id) ?? {
          stationId: s.id,
          name: s.name,
          observation: null,
          updatedAt: null,
        };
        const history = this.histories.get(s.id);
        return history ? { ...snapshot, history } : snapshot;
      }),
      configError: this.configError(),
      generatedAt: Date.now(),
      buildId: __BUILD_ID__,
    };
  }

  private configError(): string | undefined {
    if (this.tokens.length === 0) {
      return 'Missing TEMPESTWX_TOKENS environment variable (comma-separated list of WeatherFlow access tokens).';
    }
    if (this.tokenErrors.size > 0) {
      return [...this.tokenErrors.values()].join('\n\n');
    }
    return undefined;
  }

  // Never rejects: discovery and per-station polls each catch their own
  // errors, so a failed tick just leaves the previous snapshot in place.
  private async tick(): Promise<void> {
    for (const token of [...this.undiscovered]) {
      await this.discover(token);
    }
    await Promise.all(this.stations.map((s) => this.poll(s)));
  }

  private async discover(token: string): Promise<void> {
    try {
      const data = await fetchJson<StationsResponse>(
        `${WEATHERFLOW_CONFIG.REST_API_URL}/stations?token=${token}`,
      );
      for (const station of data.stations ?? []) {
        if (this.ignoreStationIds.has(station.station_id)) {
          console.info(
            `Ignoring station ${station.station_id} — in ${WEATHERFLOW_CONFIG.IGNORE_STATIONS_ENV}`,
          );
          continue;
        }
        if (this.stations.some((s) => s.id === station.station_id)) continue;
        const deviceIds = (station.devices ?? [])
          .filter((d) => WEATHER_DEVICE_TYPES.has(d.device_type ?? ''))
          .map((d) => d.device_id);
        this.stations.push({
          id: station.station_id,
          name:
            station.name ??
            station.public_name ??
            `Station ${station.station_id}`,
          token,
          deviceIds,
        });
        console.info(
          `Discovered station ${station.station_id} (${station.name ?? 'unnamed'}) with ${deviceIds.length} weather device(s)`,
        );
        if (deviceIds.length === 0) {
          // Without a device there is nothing to read raw observations from,
          // so this station's panel shows current conditions and no 24h window
          // — worth saying out loud rather than leaving it to look like a
          // fetch that never finished.
          console.warn(
            `Station ${station.station_id} reports no ST/AR/SK device; it will have no 24h history.`,
          );
        }
      }
      this.undiscovered.delete(token);
      this.tokenErrors.delete(token);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403) {
        // Rejected token: user-actionable, no point retrying.
        this.undiscovered.delete(token);
        this.tokenErrors.set(
          token,
          `WeatherFlow rejected a configured token (HTTP ${status}). Check TEMPESTWX_TOKENS.`,
        );
      }
      console.error('Failed to fetch WeatherFlow stations:', error);
    }
  }

  // Never rejects, for the same reason tick() doesn't: a station whose history
  // fetch fails keeps the window it already had.
  private async historyTick(): Promise<void> {
    await Promise.all(this.stations.map((s) => this.pollHistory(s)));
  }

  private async pollHistory(station: Station): Promise<void> {
    if (station.deviceIds.length === 0) return;
    const end = Math.floor(Date.now() / 1000);
    const start = end - WEATHERFLOW_CONFIG.HISTORY_WINDOW;

    const samples: HistorySample[] = [];
    for (const deviceId of station.deviceIds) {
      try {
        const data = await fetchJson<DeviceObsResponse>(
          `${WEATHERFLOW_CONFIG.REST_API_URL}/observations/device/${deviceId}` +
            `?token=${station.token}&time_start=${start}&time_end=${end}`,
          WEATHERFLOW_CONFIG.HISTORY_TIMEOUT,
        );
        samples.push(...decodeDeviceObs(data));
      } catch (error) {
        console.error(
          `Failed to fetch 24h history for device ${deviceId} (station ${station.id}):`,
          error,
        );
      }
    }

    const history = buildHistory(samples);
    if (history) this.histories.set(station.id, history);
  }

  private async poll(station: Station): Promise<void> {
    const prev = this.snapshots.get(station.id);
    try {
      const data = await fetchJson<StationObsResponse>(
        `${WEATHERFLOW_CONFIG.REST_API_URL}/observations/station/${station.id}?token=${station.token}`,
      );
      const obs = data.obs?.[0];
      if (!obs) return;
      const observation: StationObservation = {
        timestamp: obs.timestamp,
        temperature: obs.air_temperature,
        feelsLike: obs.feels_like,
        humidity: obs.relative_humidity,
        pressure: obs.station_pressure ?? obs.barometric_pressure,
        windSpeed: obs.wind_avg,
        windLull: obs.wind_lull,
        windGust: obs.wind_gust,
        windDirection: obs.wind_direction,
        uvIndex: obs.uv,
        solarRadiation: obs.solar_radiation,
        illuminance: obs.brightness,
        rainTotal: obs.precip_accum_local_day,
      };
      observation.barometricTrend = this.trackPressure(station.id, observation);
      this.snapshots.set(station.id, {
        stationId: station.id,
        name: station.name,
        observation,
        updatedAt: Date.now(),
      });
    } catch (error) {
      console.error(
        `Failed to poll station ${station.id} (${station.name}):`,
        error,
      );
      // Keep the last good observation; the UI shows staleness from its age.
      this.snapshots.set(station.id, {
        stationId: station.id,
        name: station.name,
        observation: prev?.observation ?? null,
        updatedAt: prev?.updatedAt ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private trackPressure(
    stationId: number,
    observation: StationObservation,
  ): BarometricTrend | undefined {
    if (observation.pressure == null || observation.timestamp == null) {
      return undefined;
    }
    const history = this.pressureHistories.get(stationId) ?? [];
    // Polls outpace the station's ~1/min reports; only record new observations.
    if (history[history.length - 1]?.t !== observation.timestamp) {
      history.push({ t: observation.timestamp, p: observation.pressure });
      const cutoff =
        Date.now() / 1000 - 2 * WEATHERFLOW_CONFIG.PRESSURE_TREND_WINDOW;
      while (history.length > 0 && history[0].t < cutoff) {
        history.shift();
      }
      this.pressureHistories.set(stationId, history);
    }
    return computeTrend(history);
  }
}

// One poller (and one poll interval) per process, surviving dev-server module
// reloads.
declare global {
  var __weatherPoller: WeatherPoller | undefined;
}

export function getWeatherSnapshot(): Promise<WeatherSnapshot> {
  globalThis.__weatherPoller ??= new WeatherPoller();
  return globalThis.__weatherPoller.getSnapshot();
}
