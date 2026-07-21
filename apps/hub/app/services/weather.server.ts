import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import type {
  BarometricTrend,
  StationObservation,
  StationObsResponse,
  StationSnapshot,
  StationsResponse,
  WeatherSnapshot,
} from '~/lib/weatherflow/types';

type Station = { id: number; name: string; token: string };
type PressureSample = { t: number; p: number };

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(WEATHERFLOW_CONFIG.API_TIMEOUT),
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
    }
    await this.firstTick;
    return {
      stations: this.stations.map(
        (s) =>
          this.snapshots.get(s.id) ?? {
            stationId: s.id,
            name: s.name,
            observation: null,
            updatedAt: null,
          },
      ),
      configError: this.configError(),
      generatedAt: Date.now(),
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
        this.stations.push({
          id: station.station_id,
          name:
            station.name ??
            station.public_name ??
            `Station ${station.station_id}`,
          token,
        });
        console.info(
          `Discovered station ${station.station_id} (${station.name ?? 'unnamed'})`,
        );
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
