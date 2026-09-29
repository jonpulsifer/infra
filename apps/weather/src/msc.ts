/**
 * The Meteorological Service of Canada's OGC API at api.weather.gc.ca. Each
 * function trims a GeoJSON collection to the fields a person asks about, in
 * English, with the unit in the key.
 */
import { bbox, distanceKm, type Point } from './geo.ts';
import type { Upstream } from './upstream.ts';

export const MSC_API = 'https://api.weather.gc.ca/collections';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// GeoJSON as the API sends it. Properties stay loose: each collection has its
// own, and a missing one reads as undefined.
type Props = Record<string, unknown>;
interface Feature {
  id?: string;
  geometry?: { type: string; coordinates: unknown } | null;
  properties: Props;
}
interface Collection {
  features?: Feature[];
}

/** A bilingual `{en, fr}` field, or a plain value, read in English. */
function en(value: unknown): unknown {
  if (value && typeof value === 'object' && 'en' in value) {
    return (value as { en: unknown }).en;
  }
  return value;
}

function at(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

const num = (value: unknown): number | undefined => {
  const v = en(value);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
};
const str = (value: unknown): string | undefined => {
  const v = en(value);
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

function point(feature: Feature): Point | undefined {
  const c = feature.geometry?.coordinates;
  if (feature.geometry?.type !== 'Point' || !Array.isArray(c)) return undefined;
  const [lon, lat] = c;
  return typeof lat === 'number' && typeof lon === 'number'
    ? { lat, lon }
    : undefined;
}

/** Drops undefined fields, so a tool result carries only what was reported. */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

function items(
  upstream: Upstream,
  collection: string,
  query: Record<string, string | number>,
  ttlMs: number,
): Promise<Feature[]> {
  const params = new URLSearchParams({ f: 'json' });
  for (const [k, v] of Object.entries(query)) params.set(k, String(v));
  return upstream
    .json<Collection>(`${MSC_API}/${collection}/items?${params}`, ttlMs)
    .then((c) => c.features ?? []);
}

/** Widens the box until something answers; a small box keeps payloads small. */
async function nearest(
  upstream: Upstream,
  collection: string,
  where: Point,
  query: Record<string, string | number>,
  ttlMs: number,
  accept: (f: Feature) => boolean = () => true,
): Promise<{ feature: Feature; distanceKm: number } | null> {
  for (const degrees of [0.25, 0.75, 2]) {
    const features = await items(
      upstream,
      collection,
      { ...query, bbox: bbox(where, degrees) },
      ttlMs,
    );
    const ranked = features
      .filter(accept)
      .map((feature) => {
        const p = point(feature);
        return {
          feature,
          distanceKm: p ? distanceKm(where, p) : Number.POSITIVE_INFINITY,
        };
      })
      .sort((a, b) => a.distanceKm - b.distanceKm);
    if (ranked[0] && ranked[0].distanceKm !== Number.POSITIVE_INFINITY)
      return ranked[0];
  }
  return null;
}

// ---- City pages: the forecast a person sees on weather.gc.ca ---------------

export interface CityRef {
  id: string;
  name: string;
  region?: string;
  point: Point;
  url?: string;
}

function cityRef(feature: Feature): CityRef | null {
  const p = point(feature);
  const id = str(feature.properties.identifier) ?? feature.id;
  const name = str(feature.properties.name);
  if (!p || !id || !name) return null;
  return compact({
    id,
    name,
    region: str(feature.properties.region),
    point: p,
    url: str(feature.properties.url),
  });
}

export async function searchCities(
  upstream: Upstream,
  text: string,
): Promise<CityRef[]> {
  const features = await items(
    upstream,
    'citypageweather-realtime',
    { q: text, limit: 10 },
    DAY,
  );
  return features.map(cityRef).filter((c): c is CityRef => c !== null);
}

export async function nearestCity(
  upstream: Upstream,
  where: Point,
): Promise<(CityRef & { distanceKm: number }) | null> {
  const found = await nearest(
    upstream,
    'citypageweather-realtime',
    where,
    { limit: 50 },
    DAY,
  );
  const ref = found && cityRef(found.feature);
  return ref && found ? { ...ref, distanceKm: found.distanceKm } : null;
}

export interface CityWeather {
  city: CityRef;
  updated?: string;
  current?: {
    observedAt?: string;
    station?: string;
    /** The station's transport code, as SWOB names it without the C. */
    stationCode?: string;
    temperatureC?: number;
    dewpointC?: number;
    humidityPct?: number;
    windKmh?: number;
    gustKmh?: number;
    windDirection?: string;
    pressureKPa?: number;
    pressureTendency?: string;
    windChill?: number;
    humidex?: number;
    condition?: string;
  };
  forecast: {
    issuedAt?: string;
    periods: { period: string; summary: string }[];
    normals?: string;
  };
  hourly: {
    time: string;
    condition?: string;
    temperatureC?: number;
    precipChancePct?: number;
    windKmh?: number;
    gustKmh?: number;
    windDirection?: string;
    windChill?: number;
    humidex?: number;
  }[];
  warnings: {
    title: string;
    type?: string;
    colour?: string;
    issuedAt?: string;
    expiresAt?: string;
    url?: string;
  }[];
  sunrise?: string;
  sunset?: string;
}

export async function cityWeather(
  upstream: Upstream,
  id: string,
): Promise<CityWeather> {
  const feature = await upstream.json<Feature>(
    `${MSC_API}/citypageweather-realtime/items/${encodeURIComponent(id)}?f=json`,
    5 * MINUTE,
  );
  const city = cityRef(feature);
  if (!city) throw new Error(`MSC city page ${id} has no name or location`);
  const p = feature.properties;
  const cc = p.currentConditions as Props | undefined;
  const temperatureC = num(at(cc, 'temperature', 'value'));
  const current =
    cc &&
    compact({
      observedAt: str(cc.timestamp),
      station: str(at(cc, 'station', 'value')),
      stationCode: str(at(cc, 'station', 'code'))?.toUpperCase(),
      temperatureC,
      dewpointC: num(at(cc, 'dewpoint', 'value')),
      humidityPct: num(at(cc, 'relativeHumidity', 'value')),
      windKmh: num(at(cc, 'wind', 'speed', 'value')),
      gustKmh: num(at(cc, 'wind', 'gust', 'value')),
      windDirection: str(at(cc, 'wind', 'direction', 'value')),
      pressureKPa: num(at(cc, 'pressure', 'value')),
      pressureTendency: str(at(cc, 'pressure', 'tendency')),
      // The feed carries a stale index in warm or cold weather; MSC reports
      // wind chill at 0 °C and below and humidex at 20 °C and above.
      windChill:
        temperatureC !== undefined && temperatureC <= 0
          ? num(at(cc, 'windChill', 'value'))
          : undefined,
      humidex:
        temperatureC !== undefined && temperatureC >= 20
          ? num(at(cc, 'humidex', 'value'))
          : undefined,
      condition: str(cc.condition),
    });
  const forecasts = (at(p, 'forecastGroup', 'forecasts') ?? []) as Props[];
  const hourly = (at(p, 'hourlyForecastGroup', 'hourlyForecasts') ??
    []) as Props[];
  const warnings = (Array.isArray(p.warnings) ? p.warnings : []) as Props[];
  return compact({
    city,
    updated: str(p.lastUpdated),
    current,
    forecast: compact({
      issuedAt: str(at(p, 'forecastGroup', 'timestamp')),
      periods: forecasts.flatMap((f) => {
        const period = str(at(f, 'period', 'textForecastName'));
        const summary = str(f.textSummary);
        return period && summary ? [{ period, summary }] : [];
      }),
      normals: str(at(p, 'forecastGroup', 'regionalNormals', 'textSummary')),
    }),
    hourly: hourly.flatMap((h) => {
      const time = str(h.timestamp);
      return time
        ? [
            compact({
              time,
              condition: str(h.condition),
              temperatureC: num(at(h, 'temperature', 'value')),
              precipChancePct: num(at(h, 'lop', 'value')),
              windKmh: num(at(h, 'wind', 'speed', 'value')),
              gustKmh: num(at(h, 'wind', 'gust', 'value')),
              windDirection: str(at(h, 'wind', 'direction', 'value')),
              windChill: num(at(h, 'windChill', 'value')),
              humidex: num(at(h, 'humidex', 'value')),
            }),
          ]
        : [];
    }),
    warnings: warnings.map((w) =>
      compact({
        title: str(w.description) ?? 'Weather warning',
        type: str(w.type),
        colour: str(w.alertColourLevel),
        issuedAt: str(w.eventIssue),
        expiresAt: str(w.expiryTime),
        url: str(w.url),
      }),
    ),
    sunrise: str(at(p, 'riseSet', 'sunrise')),
    sunset: str(at(p, 'riseSet', 'sunset')),
  });
}

// ---- SWOB: the latest reading of an observing station -----------------------

export interface StationRef {
  id: string;
  name: string;
  climateId?: string;
  provider?: string;
  point: Point;
  distanceKm: number;
}

/** Since `hours` ago, floored so the URL, and so the cache key, holds still. */
function since(hours: number, stepMs: number): string {
  const t = Date.now() - hours * HOUR;
  return `${new Date(t - (t % stepMs)).toISOString()}/..`;
}

// NAV CANADA reports name the ICAO id; MSC's own name the transport code,
// which is the ICAO id without its C. Partner stations have neither.
function reportStation(f: Feature): string | undefined {
  const icao = str(f.properties['icao_stn_id-value']);
  if (icao) return icao.toUpperCase();
  const tc = str(f.properties['tc_id-value']);
  return tc ? `C${tc.toUpperCase()}` : undefined;
}

/** A station by its SWOB id (CZDB, CYHZ), the one a city page reads. */
export async function stationById(
  upstream: Upstream,
  id: string,
  where: Point,
): Promise<StationRef | null> {
  const features = await items(
    upstream,
    'swob-stations',
    { iata_id: id, limit: 5 },
    DAY,
  );
  // One station can list twice, automatic and manual; the automatic one reports.
  const f =
    features.find((x) => str(x.properties.auto_man) === 'AUTO') ?? features[0];
  const p = f && point(f);
  if (!f || !p) return null;
  return compact({
    id,
    name: str(f.properties.name) ?? id,
    climateId: str(f.properties.msc_id),
    provider: str(f.properties.data_provider),
    point: p,
    distanceKm: distanceKm(where, p),
  });
}

/**
 * The nearest station that has reported in the last two hours. SWOB stations
 * include retired ones, so a fresh report is the only proof of life.
 */
export async function nearestStation(
  upstream: Upstream,
  where: Point,
): Promise<StationRef | null> {
  for (const degrees of [0.3, 1, 2.5]) {
    const features = await items(
      upstream,
      'swob-realtime',
      {
        bbox: bbox(where, degrees),
        datetime: since(2, 10 * MINUTE),
        sortby: '-date_tm-value',
        limit: 500,
      },
      30 * MINUTE,
    );
    const seen = new Map<string, StationRef>();
    for (const f of features) {
      const p = point(f);
      const id = reportStation(f);
      if (!p || !id || seen.has(id)) continue;
      seen.set(
        id,
        compact({
          id,
          name: str(f.properties['stn_nam-value']) ?? id,
          climateId: str(f.properties['clim_id-value']),
          provider: str(f.properties['data_pvdr-value']),
          point: p,
          distanceKm: distanceKm(where, p),
        }),
      );
    }
    const closest = [...seen.values()].sort(
      (a, b) => a.distanceKm - b.distanceKm,
    )[0];
    if (closest) return closest;
  }
  return null;
}

export interface StationReading {
  station: string;
  observedAt?: string;
  temperatureC?: number;
  dewpointC?: number;
  humidityPct?: number;
  windKmh?: number;
  windDirectionDeg?: number;
  gustKmh?: number;
  stationPressureHPa?: number;
  seaLevelPressureHPa?: number;
  precipLastHourMm?: number;
  snowDepthCm?: number;
  visibilityKm?: number;
  high24hC?: number;
  low24hC?: number;
}

// Minute reports and hourly or NAV CANADA reports name the same measurement
// over different windows; the first one present wins. MSC flags a suspect
// value with a negative `-qa`, and such a value is left out.
const pick = (p: Props, ...keys: string[]) => {
  for (const key of keys) {
    const v = num(p[key]);
    const qa = num(p[`${key}-qa`]);
    if (v !== undefined && (qa === undefined || qa >= 0)) return v;
  }
  return undefined;
};

export async function latestReading(
  upstream: Upstream,
  station: StationRef,
): Promise<StationReading | null> {
  const features = await items(
    upstream,
    'swob-realtime',
    {
      bbox: bbox(station.point, 0.01),
      datetime: since(3, MINUTE),
      sortby: '-date_tm-value',
      limit: 90,
    },
    MINUTE,
  );
  const reports = features.filter((f) => reportStation(f) === station.id);
  const latest = reports[0];
  if (!latest) return null;
  // A minute report carries no 24 h extremes; the latest hourly one does.
  const hourly = reports.find(
    (f) => num(f.properties.max_air_temp_pst24hrs) !== undefined,
  );
  const p = latest.properties;
  return compact({
    station: station.name,
    observedAt: str(p['date_tm-value']) ?? str(p.obs_date_tm),
    temperatureC: pick(p, 'air_temp'),
    dewpointC: pick(p, 'dwpt_temp'),
    humidityPct: pick(p, 'rel_hum'),
    windKmh: pick(
      p,
      'avg_wnd_spd_10m_pst1mt',
      'avg_wnd_spd_10m_pst2mts',
      'avg_wnd_spd_10m_pst10mts',
    ),
    windDirectionDeg: pick(
      p,
      'avg_wnd_dir_10m_pst1mt',
      'avg_wnd_dir_10m_pst2mts',
      'avg_wnd_dir_10m_pst10mts',
    ),
    gustKmh: pick(
      p,
      'max_wnd_spd_10m_pst1mt',
      'max_wnd_gst_spd_10m_pst10mts',
      'max_wnd_spd_10m_pst1hr',
    ),
    stationPressureHPa: pick(p, 'stn_pres'),
    seaLevelPressureHPa: pick(p, 'mslp'),
    precipLastHourMm: pick(p, 'pcpn_amt_pst1hr'),
    snowDepthCm: pick(p, 'snw_dpth'),
    visibilityKm: pick(p, 'avg_vis_pst10mts'),
    high24hC: hourly && num(hourly.properties.max_air_temp_pst24hrs),
    low24hC: hourly && num(hourly.properties.min_air_temp_pst24hrs),
  });
}

// ---- Alerts -----------------------------------------------------------------

export interface Alert {
  name: string;
  type?: string;
  colour?: string;
  area?: string;
  issuedAt?: string;
  startsAt?: string;
  endsAt?: string;
  expiresAt?: string;
  confidence?: string;
  impact?: string;
  text?: string;
}

/**
 * The alerts whose area covers the point. A 0.02° box stands in for
 * containment; an alert drawn a kilometre away is still worth reading.
 */
export async function alertsAt(
  upstream: Upstream,
  where: Point,
): Promise<Alert[]> {
  const features = await items(
    upstream,
    'weather-alerts',
    { bbox: bbox(where, 0.01), limit: 50 },
    2 * MINUTE,
  );
  const seen = new Set<string>();
  const alerts: Alert[] = [];
  for (const f of features) {
    const p = f.properties;
    const key = `${p.alert_code}|${p.publication_datetime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    alerts.push(
      compact({
        name: str(p.alert_short_name_en) ?? str(p.alert_name_en) ?? 'Alert',
        type: str(p.alert_type),
        colour: str(p.risk_colour_en),
        area: str(p.feature_name_en),
        issuedAt: str(p.publication_datetime),
        startsAt: str(p.validity_datetime),
        endsAt: str(p.event_end_datetime),
        expiresAt: str(p.expiration_datetime),
        confidence: str(p.confidence_en),
        impact: str(p.impact_en),
        text: str(p.alert_text_en),
      }),
    );
  }
  return alerts;
}

// ---- Air quality ------------------------------------------------------------

export interface AirQuality {
  location: string;
  distanceKm: number;
  observed?: { time?: string; aqhi?: number; notes?: string };
  forecast: { time: string; aqhi: number }[];
  scale: string;
}

export async function airQuality(
  upstream: Upstream,
  where: Point,
): Promise<AirQuality | null> {
  const obs = await nearest(
    upstream,
    'aqhi-observations-realtime',
    where,
    { latest: 'true', limit: 50 },
    10 * MINUTE,
  );
  if (!obs) return null;
  const locationId = str(obs.feature.properties.location_id);
  const forecasts = locationId
    ? await items(
        upstream,
        'aqhi-forecasts-realtime',
        // `datetime` filters nothing here; the newest publication comes first.
        {
          location_id: locationId,
          sortby: '-publication_datetime',
          limit: 72,
        },
        10 * MINUTE,
      )
    : [];
  const p = obs.feature.properties;
  const newest = str(forecasts[0]?.properties.publication_datetime);
  const hourAgo = new Date(Date.now() - HOUR).toISOString();
  const forecast = forecasts
    .filter((f) => str(f.properties.publication_datetime) === newest)
    .flatMap((f) => {
      const time = str(f.properties.forecast_datetime);
      const aqhi = num(f.properties.aqhi);
      return time && time >= hourAgo && aqhi !== undefined
        ? [{ time, aqhi }]
        : [];
    })
    .sort((a, b) => a.time.localeCompare(b.time));
  return {
    location: str(p.location_name_en) ?? locationId ?? 'unknown',
    distanceKm: obs.distanceKm,
    observed: compact({
      time: str(p.observation_datetime),
      aqhi: num(p.aqhi),
      notes: str(p.special_notes_en),
    }),
    forecast,
    scale:
      'AQHI 1-3 low risk, 4-6 moderate, 7-10 high, above 10 very high health risk',
  };
}

// ---- Climate ----------------------------------------------------------------

export interface ClimateDay {
  date: string;
  meanC?: number;
  highC?: number;
  lowC?: number;
  precipMm?: number;
  rainMm?: number;
  snowCm?: number;
  snowOnGroundCm?: number;
  maxGustKmh?: number;
  maxGustDirectionTensDeg?: number;
}

export async function climateDaily(
  upstream: Upstream,
  climateId: string,
  from: string,
  to: string,
): Promise<{ station?: string; days: ClimateDay[] }> {
  const features = await items(
    upstream,
    'climate-daily',
    {
      CLIMATE_IDENTIFIER: climateId,
      datetime: `${from}/${to}`,
      sortby: 'LOCAL_DATE',
      limit: 400,
    },
    HOUR,
  );
  return {
    station: str(features[0]?.properties.STATION_NAME),
    days: features.map((f) => {
      const p = f.properties;
      return compact({
        date: (str(p.LOCAL_DATE) ?? '').slice(0, 10),
        meanC: num(p.MEAN_TEMPERATURE),
        highC: num(p.MAX_TEMPERATURE),
        lowC: num(p.MIN_TEMPERATURE),
        precipMm: num(p.TOTAL_PRECIPITATION),
        rainMm: num(p.TOTAL_RAIN),
        snowCm: num(p.TOTAL_SNOW),
        snowOnGroundCm: num(p.SNOW_ON_GROUND),
        maxGustKmh: num(p.SPEED_MAX_GUST),
        maxGustDirectionTensDeg: num(p.DIRECTION_MAX_GUST),
      });
    }),
  };
}

export interface Records {
  area: string;
  date: string;
  since?: string;
  highestMaxC?: { value: number; year?: number };
  lowestMaxC?: { value: number; year?: number };
  highestMinC?: { value: number; year?: number };
  lowestMinC?: { value: number; year?: number };
  mostPrecipMm?: { value: number; year?: number };
  mostSnowCm?: { value: number; year?: number };
}

const record = (p: Props | undefined, key: string) => {
  const value = p && num(p[key]);
  return value === undefined
    ? undefined
    : compact({ value, year: p && num(p[`${key}_YR`]) });
};

/**
 * The long-term climate extremes for one calendar day. The API ignores a
 * WXO_CITY_CODE filter, so the box finds the area and the code confirms it.
 */
export async function recordsFor(
  upstream: Upstream,
  city: CityRef,
  month: number,
  day: number,
): Promise<Records | null> {
  const code = city.id.toUpperCase();
  const load = (collection: string) =>
    items(
      upstream,
      collection,
      {
        bbox: bbox(city.point, 0.5),
        LOCAL_MONTH: month,
        LOCAL_DAY: day,
        limit: 50,
      },
      DAY,
    ).then(
      (features) =>
        features.find(
          (f) =>
            str(f.properties.WXO_CITY_CODE)?.toUpperCase() === code &&
            num(f.properties.LOCAL_MONTH) === month &&
            num(f.properties.LOCAL_DAY) === day,
        )?.properties,
    );
  const [temperature, precipitation, snowfall] = await Promise.all([
    load('ltce-temperature'),
    load('ltce-precipitation'),
    load('ltce-snowfall'),
  ]);
  if (!temperature && !precipitation && !snowfall) return null;
  const any = temperature ?? precipitation ?? snowfall;
  return compact({
    area: str(any?.VIRTUAL_STATION_NAME_E) ?? city.name,
    date: `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    since: str(temperature?.MAX_TEMP_RECORD_BEGIN)?.slice(0, 4),
    highestMaxC: record(temperature, 'RECORD_HIGH_MAX_TEMP'),
    lowestMaxC: record(temperature, 'RECORD_LOW_MAX_TEMP'),
    highestMinC: record(temperature, 'RECORD_HIGH_MIN_TEMP'),
    lowestMinC: record(temperature, 'RECORD_LOW_MIN_TEMP'),
    mostPrecipMm: record(precipitation, 'RECORD_PRECIPITATION'),
    mostSnowCm: record(snowfall, 'RECORD_SNOWFALL'),
  });
}

export interface Normals {
  station: string;
  distanceKm: number;
  period?: string;
  month: number;
  values: Record<string, number>;
}

// The monthly normals worth quoting, by NORMAL_ID.
const NORMAL_ELEMENTS: Record<number, string> = {
  1: 'meanDailyC',
  5: 'meanDailyHighC',
  8: 'meanDailyLowC',
  52: 'rainfallMm',
  54: 'snowfallCm',
  56: 'precipitationMm',
  69: 'daysWithPrecip',
};

export async function normalsFor(
  upstream: Upstream,
  where: Point,
  month: number,
): Promise<Normals | null> {
  const found = await nearest(
    upstream,
    'climate-normals',
    where,
    { MONTH: month, NORMAL_ID: 1, limit: 100 },
    DAY,
  );
  const climateId = found && str(found.feature.properties.CLIMATE_IDENTIFIER);
  if (!found || !climateId) return null;
  const rows = await items(
    upstream,
    'climate-normals',
    { CLIMATE_IDENTIFIER: climateId, MONTH: month, limit: 200 },
    DAY,
  );
  const values: Record<string, number> = {};
  for (const row of rows) {
    const name = NORMAL_ELEMENTS[num(row.properties.NORMAL_ID) ?? -1];
    const value = num(row.properties.VALUE);
    if (name && value !== undefined) values[name] = value;
  }
  const p = found.feature.properties;
  return compact({
    station: str(p.STATION_NAME) ?? climateId,
    distanceKm: found.distanceKm,
    period:
      num(p.PERIOD_BEGIN) && num(p.PERIOD_END)
        ? `${num(p.PERIOD_BEGIN)}-${num(p.PERIOD_END)}`
        : undefined,
    month,
    values,
  });
}

// ---- Hurricanes -------------------------------------------------------------

export interface Storm {
  name: string;
  basin?: string;
  classification?: string;
  category?: string;
  publishedAt?: string;
  position?: Point;
  maxWindKt?: number;
  gustKt?: number;
  pressureHPa?: number;
  movingTowardDeg?: number;
  speedKt?: number;
  track: { time: string; position: Point; maxWindKt?: number }[];
}

export async function activeStorms(upstream: Upstream): Promise<Storm[]> {
  const features = await items(
    upstream,
    'hurricanes-cyclone-realtime',
    { active: 'true', limit: 500 },
    10 * MINUTE,
  );
  const storms = new Map<string, Feature[]>();
  for (const f of features) {
    if (f.properties.latest_publication !== true) continue;
    const name = str(f.properties.storm_name);
    if (!name) continue;
    storms.set(name, [...(storms.get(name) ?? []), f]);
  }
  return [...storms.entries()].map(([name, points]) => {
    const byTime = points
      .map((f) => ({ f, time: str(f.properties.forecast_datetime) ?? '' }))
      .sort((a, b) => a.time.localeCompare(b.time));
    const now = byTime[0]?.f.properties ?? {};
    return compact({
      name,
      basin: str(now.basin),
      classification: str(now['metobject.classification']),
      category: str(now['metobject.sub_type']),
      publishedAt: str(now.publication_datetime),
      position: byTime[0] && point(byTime[0].f),
      maxWindKt: num(now['metobject.max_wind.value']),
      gustKt: num(now['metobject.wind_gust.value']),
      pressureHPa: num(now['metobject.pressure.value']),
      movingTowardDeg: num(at(now, 'metobject.motion.direction', 'value')),
      speedKt: num(at(now, 'metobject.motion.intensity', 'value')),
      track: byTime.flatMap(({ f, time }) => {
        const position = point(f);
        return position
          ? [
              compact({
                time,
                position,
                maxWindKt: num(f.properties['metobject.max_wind.value']),
              }),
            ]
          : [];
      }),
    });
  });
}

// ---- Marine -----------------------------------------------------------------

export interface MarineForecast {
  area: string;
  region?: string;
  issuedAt?: string;
  forecast: string[];
  extended: { period: string; text: string }[];
  warnings: string[];
}

export async function marineForecast(
  upstream: Upstream,
  where: Point,
): Promise<MarineForecast | null> {
  for (const degrees of [0.2, 0.6, 1.5]) {
    const features = await items(
      upstream,
      'marineweather-realtime',
      { bbox: bbox(where, degrees), limit: 20 },
      10 * MINUTE,
    );
    const f = features[0];
    if (!f) continue;
    const p = f.properties;
    const regular = (at(p, 'regularForecast', 'locations') ?? []) as Props[];
    const extended = (at(p, 'extendedForecast', 'locations') ?? []) as Props[];
    const warnings = (at(p, 'warnings', 'locations') ?? []) as Props[];
    return compact({
      area: str(at(p, 'area', 'value')) ?? 'Marine area',
      region: str(at(p, 'area', 'subRegion')),
      issuedAt: str(at(p, 'regularForecast', 'issuedDatetimeUTC')),
      forecast: regular.flatMap((loc) => {
        const wc = (loc.weatherCondition ?? {}) as Props;
        return [
          str(wc.periodOfCoverage),
          str(wc.wind),
          str(wc.weatherVisibility),
          str(wc.airTemperature),
          str(wc.freezingSpray),
        ].filter((s): s is string => s !== undefined);
      }),
      extended: extended.flatMap((loc) =>
        ((at(loc, 'weatherCondition', 'forecastPeriods') ?? []) as Props[])
          .map((fp) => ({ period: str(fp.name), text: str(fp.value) }))
          .filter(
            (x): x is { period: string; text: string } =>
              x.period !== undefined && x.text !== undefined,
          ),
      ),
      warnings: warnings.flatMap((loc) =>
        ((loc.events ?? []) as Props[])
          .map((e) =>
            [str(e.type), str(e.name), str(e.status)].filter(Boolean).join(' '),
          )
          .filter((s) => s !== ''),
      ),
    });
  }
  return null;
}
