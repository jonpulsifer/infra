/**
 * The family's WeatherFlow Tempest stations. Each token reaches the stations
 * of one account; the token never leaves this module, so no URL or error that
 * carries it is returned.
 */
import { distanceKm, localTime, type Point } from './geo.ts';
import type { Upstream } from './upstream.ts';

export const WEATHERFLOW_API = 'https://swd.weatherflow.com/swd/rest';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// A hub (HB) reports no weather.
const WEATHER_DEVICES = new Set(['ST', 'AR', 'SK']);
const UNITS =
  'units_temp=c&units_wind=kph&units_pressure=mb&units_precip=mm&units_distance=km';

export interface TempestStation {
  id: number;
  name: string;
  point: Point;
  timezone: string;
  deviceIds: number[];
}

interface Secret {
  token: string;
}

interface StationsResponse {
  stations?: {
    station_id: number;
    name?: string;
    public_name?: string;
    latitude?: number;
    longitude?: number;
    timezone?: string;
    devices?: { device_id: number; device_type?: string }[];
  }[];
}

interface ForecastResponse {
  current_conditions?: Record<string, unknown>;
  forecast?: {
    daily?: Record<string, unknown>[];
    hourly?: Record<string, unknown>[];
  };
}

interface DeviceObsResponse {
  type?: string;
  obs?: (number | null)[][] | null;
}

export interface TempestConditions {
  station: string;
  stationId: number;
  observedAt?: string;
  conditions?: string;
  temperatureC?: number;
  feelsLikeC?: number;
  dewpointC?: number;
  humidityPct?: number;
  windKmh?: number;
  gustKmh?: number;
  windDirection?: string;
  seaLevelPressureHPa?: number;
  pressureTrend?: string;
  uvIndex?: number;
  solarRadiationWm2?: number;
  rainTodayMm?: number;
  rainYesterdayMm?: number;
  lightningStrikesLastHour?: number;
  lightningStrikesLast3Hours?: number;
  lastLightning?: string;
  lastLightningDistance?: string;
}

export interface TempestDay {
  date: string;
  conditions?: string;
  highC?: number;
  lowC?: number;
  precipChancePct?: number;
  precipType?: string;
}

const n = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const s = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

export class Tempest {
  private readonly secrets = new Map<number, Secret>();

  constructor(
    private readonly upstream: Upstream,
    private readonly tokens: readonly string[],
    private readonly ignore: ReadonlySet<number> = new Set(),
  ) {}

  get configured(): boolean {
    return this.tokens.length > 0;
  }

  /** A token that fails is skipped, so one bad account hides only its own. */
  async stations(): Promise<TempestStation[]> {
    const found = new Map<number, TempestStation>();
    await Promise.all(
      this.tokens.map(async (token) => {
        let data: StationsResponse;
        try {
          data = await this.upstream.json<StationsResponse>(
            `${WEATHERFLOW_API}/stations?token=${encodeURIComponent(token)}`,
            HOUR,
          );
        } catch (error) {
          console.error('WeatherFlow station discovery failed:', error);
          return;
        }
        for (const st of data.stations ?? []) {
          if (this.ignore.has(st.station_id) || found.has(st.station_id)) {
            continue;
          }
          if (st.latitude == null || st.longitude == null) continue;
          this.secrets.set(st.station_id, { token });
          found.set(st.station_id, {
            id: st.station_id,
            name: st.name ?? st.public_name ?? `Station ${st.station_id}`,
            point: { lat: st.latitude, lon: st.longitude },
            timezone: st.timezone ?? 'America/Halifax',
            deviceIds: (st.devices ?? [])
              .filter((d) => WEATHER_DEVICES.has(d.device_type ?? ''))
              .map((d) => d.device_id),
          });
        }
      }),
    );
    return [...found.values()].sort((a, b) => a.id - b.id);
  }

  async near(where: Point, withinKm: number) {
    return (await this.stations())
      .map((station) => ({
        station,
        distanceKm: distanceKm(where, station.point),
      }))
      .filter((x) => x.distanceKm <= withinKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }

  async find(text: string): Promise<TempestStation | undefined> {
    const wanted = text.trim().toLowerCase();
    return (await this.stations()).find(
      (st) => String(st.id) === wanted || st.name.toLowerCase() === wanted,
    );
  }

  private async forecastFor(station: TempestStation) {
    const token = this.token(station);
    return this.upstream.json<ForecastResponse>(
      `${WEATHERFLOW_API}/better_forecast?station_id=${station.id}&token=${encodeURIComponent(token)}&${UNITS}`,
      MINUTE,
    );
  }

  async conditions(station: TempestStation): Promise<TempestConditions> {
    const c = (await this.forecastFor(station)).current_conditions ?? {};
    const zone = station.timezone;
    return compact({
      station: station.name,
      stationId: station.id,
      observedAt: localTime(n(c.time), zone),
      conditions: s(c.conditions),
      temperatureC: n(c.air_temperature),
      feelsLikeC: n(c.feels_like),
      dewpointC: n(c.dew_point),
      humidityPct: n(c.relative_humidity),
      windKmh: n(c.wind_avg),
      gustKmh: n(c.wind_gust),
      windDirection: s(c.wind_direction_cardinal),
      seaLevelPressureHPa: n(c.sea_level_pressure),
      pressureTrend: s(c.pressure_trend),
      uvIndex: n(c.uv),
      solarRadiationWm2: n(c.solar_radiation),
      rainTodayMm: n(c.precip_accum_local_day),
      rainYesterdayMm: n(c.precip_accum_local_yesterday),
      lightningStrikesLastHour: n(c.lightning_strike_count_last_1hr),
      lightningStrikesLast3Hours: n(c.lightning_strike_count_last_3hr),
      lastLightning: localTime(n(c.lightning_strike_last_epoch), zone),
      lastLightningDistance: s(c.lightning_strike_last_distance_msg),
    });
  }

  async daily(station: TempestStation): Promise<TempestDay[]> {
    const days = (await this.forecastFor(station)).forecast?.daily ?? [];
    return days.map((d) =>
      compact({
        date: (localTime(n(d.day_start_local), station.timezone) ?? '').slice(
          0,
          10,
        ),
        conditions: s(d.conditions),
        highC: n(d.air_temp_high),
        lowC: n(d.air_temp_low),
        precipChancePct: n(d.precip_probability),
        precipType: s(d.precip_type),
      }),
    );
  }

  /** Raw device rows over the window, merged across an AIR and a SKY. */
  async samples(
    station: TempestStation,
    hours: number,
    now = Date.now(),
  ): Promise<Sample[]> {
    const token = this.token(station);
    // Floored to the cache TTL, so repeat questions reuse one fetch.
    const end = Math.floor(now / 1000 / 300) * 300;
    const start = end - hours * 3600;
    const rows = await Promise.all(
      station.deviceIds.map((id) =>
        this.upstream
          .json<DeviceObsResponse>(
            `${WEATHERFLOW_API}/observations/device/${id}?token=${encodeURIComponent(token)}&time_start=${start}&time_end=${end}`,
            5 * MINUTE,
            30_000,
          )
          .then(decode),
      ),
    );
    return rows.flat().sort((a, b) => a.t - b.t);
  }

  private token(station: TempestStation): string {
    const secret = this.secrets.get(station.id);
    if (!secret) throw new Error(`no token reaches station ${station.id}`);
    return secret.token;
  }
}

/** One device row; wind in m/s as the device reports it. */
export interface Sample {
  t: number;
  tempC?: number;
  humidityPct?: number;
  pressureMb?: number;
  windMs?: number;
  gustMs?: number;
  rainMm?: number;
  lightning?: number;
  uv?: number;
  solarWm2?: number;
}

type Layout = Partial<Record<Exclude<keyof Sample, 't'>, number>>;

// Field positions of WeatherFlow's device observation rows. `rainMm` covers
// one report interval, so summing it gives the window's rain.
const LAYOUTS: Record<string, Layout> = {
  obs_st: {
    windMs: 2,
    gustMs: 3,
    pressureMb: 6,
    tempC: 7,
    humidityPct: 8,
    uv: 10,
    solarWm2: 11,
    rainMm: 12,
    lightning: 15,
  },
  obs_air: { pressureMb: 1, tempC: 2, humidityPct: 3, lightning: 4 },
  obs_sky: { uv: 2, rainMm: 3, windMs: 5, gustMs: 6, solarWm2: 10 },
};

export function decode(res: DeviceObsResponse): Sample[] {
  const layout = res.type ? LAYOUTS[res.type] : undefined;
  if (!layout || !res.obs) return [];
  const samples: Sample[] = [];
  for (const row of res.obs) {
    const t = row[0];
    if (typeof t !== 'number') continue;
    const sample: Sample = { t };
    for (const [field, index] of Object.entries(layout) as [
      keyof Layout,
      number,
    ][]) {
      const v = row[index];
      if (typeof v === 'number' && Number.isFinite(v)) sample[field] = v;
    }
    samples.push(sample);
  }
  return samples;
}

export interface HistoryBucket {
  start: string;
  lowC?: number;
  highC?: number;
  meanC?: number;
  meanHumidityPct?: number;
  meanWindKmh?: number;
  maxGustKmh?: number;
  rainMm?: number;
  lightningStrikes?: number;
  pressureHPa?: number;
  maxUv?: number;
}

const round = (v: number, places = 1) => {
  const f = 10 ** places;
  return Math.round(v * f) / f;
};
const mean = (xs: number[]) =>
  xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : undefined;
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : undefined);
const min = (xs: number[]) => (xs.length ? Math.min(...xs) : undefined);
const sum = (xs: number[]) =>
  xs.length
    ? round(
        xs.reduce((a, b) => a + b, 0),
        2,
      )
    : undefined;

/**
 * Hourly buckets up to two days, daily beyond, labelled in the station's zone.
 * Local midnight comes from the label, so a DST change keeps days whole.
 */
export function summarize(
  samples: readonly Sample[],
  zone: string,
  daily: boolean,
): HistoryBucket[] {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples) {
    const label = localTime(sample.t, zone);
    if (!label) continue;
    const key = daily ? label.slice(0, 10) : `${label.slice(0, 13)}:00`;
    groups.set(key, [...(groups.get(key) ?? []), sample]);
  }
  return [...groups.entries()].map(([start, group]) => {
    const pick = (f: keyof Sample) =>
      group.map((g) => g[f]).filter((v): v is number => v !== undefined);
    const kmh = (xs: number[]) => xs.map((x) => x * 3.6);
    const pressure = pick('pressureMb');
    return compact({
      start,
      lowC: min(pick('tempC')),
      highC: max(pick('tempC')),
      meanC: mean(pick('tempC')),
      meanHumidityPct: mean(pick('humidityPct')),
      meanWindKmh: mean(kmh(pick('windMs'))),
      maxGustKmh: (() => {
        const g = max(kmh(pick('gustMs')));
        return g === undefined ? undefined : round(g);
      })(),
      rainMm: sum(pick('rainMm')),
      lightningStrikes: sum(pick('lightning')),
      pressureHPa: pressure.at(-1),
      maxUv: max(pick('uv')),
    });
  });
}
