/**
 * What the weather API answers. Each operation is one MCP tool and one
 * `GET /v1/<name>`; both surfaces read this registry and nothing else.
 */
import { z } from 'zod';
import { burnSafe } from './burnsafe.ts';
import { distanceKm, localDate, localTime } from './geo.ts';
import {
  activeStorms,
  airQuality,
  alertsAt,
  cityWeather,
  climateDaily,
  latestReading,
  marineForecast,
  nearestStation,
  normalsFor,
  recordsFor,
  stationById,
} from './msc.ts';
import type { Place, Places } from './places.ts';
import { summarize, type Tempest } from './tempest.ts';
import type { Upstream } from './upstream.ts';

export interface Deps {
  upstream: Upstream;
  tempest: Tempest;
  places: Places;
  now?: () => number;
}

export interface Operation {
  name: string;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run(args: Record<string, unknown>, deps: Deps): Promise<unknown>;
}

function op<S extends z.ZodRawShape>(
  name: string,
  title: string,
  description: string,
  input: S,
  run: (args: z.infer<z.ZodObject<S>>, deps: Deps) => Promise<unknown>,
): Operation {
  const schema = z.object(input).strict();
  return {
    name,
    title,
    description,
    input,
    run: (args, deps) => run(schema.parse(args), deps),
  };
}

/** Tempest stations this close to a place report its weather too. */
export const TEMPEST_RADIUS_KM = 30;

const place = z
  .string()
  .max(100)
  .optional()
  .describe(
    'A configured place name, a Tempest station name, a Canadian town or city, or "lat,lon". Omit for home, the first configured place.',
  );

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('YYYY-MM-DD');

/** One part failing leaves the rest of the answer standing. */
async function part<T>(
  label: string,
  errors: string[],
  load: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await load();
  } catch (error) {
    errors.push(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

/** Every UTC timestamp in the answer, restated in the place's zone. */
export function localize<T>(value: T, zone: string): T {
  if (typeof value === 'string' && ISO.test(value)) {
    return (localTime(value, zone) ?? value) as T;
  }
  if (Array.isArray(value)) return value.map((v) => localize(v, zone)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, localize(v, zone)]),
    ) as T;
  }
  return value;
}

function about(p: Place) {
  return {
    name: p.name,
    forecastArea: p.city.name,
    region: p.city.region,
    cityPageId: p.city.id,
    weatherGcCa: p.city.url,
    timezone: p.timezone,
  };
}

/**
 * The station weather.gc.ca reads for the place's city page, so answers match
 * the page a person checks; the nearest reporting station when it has none.
 */
async function stationFor(deps: Deps, p: Place) {
  const code = (await cityWeather(deps.upstream, p.city.id)).current
    ?.stationCode;
  const official =
    code && (await stationById(deps.upstream, `C${code}`, p.point));
  return official || nearestStation(deps.upstream, p.point);
}

async function tempestNear(deps: Deps, p: Place) {
  if (!deps.tempest.configured) return [];
  return deps.tempest.near(p.point, TEMPEST_RADIUS_KM);
}

export const operations: readonly Operation[] = [
  op(
    'places',
    'Known places',
    'Lists the configured places and the Tempest stations, with the MSC forecast area and nearest official station for each place.',
    {},
    async (_args, deps) => {
      const errors: string[] = [];
      const places = await Promise.all(
        deps.places.named.map(async (named) => {
          const p = await part(named.name, errors, () =>
            deps.places.resolve(named.name),
          );
          if (!p) return { name: named.name };
          const station = await part(`${named.name} station`, errors, () =>
            stationFor(deps, p),
          );
          return {
            ...about(p),
            officialStation: station && {
              id: station.id,
              name: station.name,
              distanceKm: station.distanceKm,
            },
          };
        }),
      );
      const tempest = deps.tempest.configured
        ? ((await part('tempest', errors, () => deps.tempest.stations())) ?? [])
        : [];
      return {
        places,
        tempestStations: tempest.map((s) => ({
          id: s.id,
          name: s.name,
          timezone: s.timezone,
        })),
        ...(errors.length > 0 && { errors }),
      };
    },
  ),

  op(
    'current_conditions',
    'Current conditions',
    "Current weather at a place: Environment Canada's official conditions, the latest reading of the nearest observing station (updated every minute at most stations), any family Tempest station within 30 km (with lightning), and active alerts. Metric units.",
    { place },
    async ({ place: query }, deps) => {
      const p = await deps.places.resolve(query);
      const errors: string[] = [];
      const [city, reading, tempest, alerts] = await Promise.all([
        part('official conditions', errors, () =>
          cityWeather(deps.upstream, p.city.id),
        ),
        part('nearest station', errors, async () => {
          const station = await stationFor(deps, p);
          if (!station) return null;
          const latest = await latestReading(deps.upstream, station);
          return latest && { ...latest, distanceKm: station.distanceKm };
        }),
        part('tempest', errors, async () =>
          Promise.all(
            (await tempestNear(deps, p)).map(
              async ({ station, distanceKm }) => ({
                ...(await deps.tempest.conditions(station)),
                // Coarse, so distances from chosen points never locate a home.
                distanceKm: Math.round(distanceKm / 5) * 5,
              }),
            ),
          ),
        ),
        part('alerts', errors, () => alertsAt(deps.upstream, p.point)),
      ]);
      return localize(
        {
          place: about(p),
          official: city?.current,
          latestStationReading: reading ?? undefined,
          tempest: tempest?.length ? tempest : undefined,
          alerts: alerts?.map((a) => `${a.name} (${a.colour ?? a.type})`),
          sunrise: city?.sunrise,
          sunset: city?.sunset,
          ...(errors.length > 0 && { errors }),
        },
        p.timezone,
      );
    },
  ),

  op(
    'forecast',
    'Forecast',
    "Environment Canada's forecast for a place: text periods for about six days, the next hours hour by hour, and warnings in effect. Adds the daily forecast of a family Tempest station within 30 km when there is one.",
    {
      place,
      hours: z
        .number()
        .int()
        .min(0)
        .max(24)
        .optional()
        .describe('Hourly forecast hours to include, 0 to 24. Default 12.'),
    },
    async ({ place: query, hours = 12 }, deps) => {
      const p = await deps.places.resolve(query);
      const errors: string[] = [];
      const [city, tempest] = await Promise.all([
        part('forecast', errors, () => cityWeather(deps.upstream, p.city.id)),
        part('tempest', errors, async () => {
          const nearest = (await tempestNear(deps, p))[0];
          return (
            nearest && {
              station: nearest.station.name,
              days: await deps.tempest.daily(nearest.station),
            }
          );
        }),
      ]);
      return localize(
        {
          place: about(p),
          issuedAt: city?.forecast.issuedAt,
          periods: city?.forecast.periods,
          hourly: city?.hourly.slice(0, hours),
          warnings: city?.warnings,
          normals: city?.forecast.normals,
          tempestForecast: tempest ?? undefined,
          ...(errors.length > 0 && { errors }),
        },
        p.timezone,
      );
    },
  ),

  op(
    'alerts',
    'Weather alerts',
    'Active Environment Canada warnings, watches, advisories and statements, with their full text. Omit the place to check every configured place.',
    { place },
    async ({ place: query }, deps) => {
      const queries = query ? [query] : deps.places.named.map((n) => n.name);
      return Promise.all(
        queries.map(async (q) => {
          const p = await deps.places.resolve(q);
          return localize(
            {
              place: about(p),
              alerts: await alertsAt(deps.upstream, p.point),
            },
            p.timezone,
          );
        }),
      );
    },
  ),

  op(
    'tempest_history',
    'Tempest history',
    'What a family Tempest station recorded: lows, highs, rain, wind, gusts and lightning, hourly for up to 48 hours or daily beyond. Name a station, or a place with a station within 30 km.',
    {
      place: place.describe(
        'A Tempest station name or id, or a place with a station within 30 km. Omit for home.',
      ),
      hours: z
        .number()
        .int()
        .min(1)
        .max(240)
        .optional()
        .describe('How far back, in hours, 1 to 240. Default 24.'),
    },
    async ({ place: query, hours = 24 }, deps) => {
      if (!deps.tempest.configured) {
        throw new Error('no Tempest token is configured');
      }
      const station =
        (query && (await deps.tempest.find(query))) ||
        (await tempestNear(deps, await deps.places.resolve(query)))[0]?.station;
      if (!station) {
        throw new Error(
          `no Tempest station within ${TEMPEST_RADIUS_KM} km of ${query ?? 'home'}; the climate tool has official daily history`,
        );
      }
      const samples = await deps.tempest.samples(station, hours, deps.now?.());
      return {
        station: station.name,
        timezone: station.timezone,
        hours,
        buckets: summarize(samples, station.timezone, hours > 48),
      };
    },
  ),

  op(
    'climate',
    'Daily climate',
    "Official daily climate observations (high, low, mean, rain, snow, snow on ground, peak gust) from the nearest Environment Canada station, for a date range. Recent days appear after a lag of a day or two. Use for 'how much rain fell last week' or past-year comparisons.",
    {
      place,
      from: isoDate
        .optional()
        .describe('First day, YYYY-MM-DD. Default 7 days ago.'),
      to: isoDate.optional().describe('Last day, YYYY-MM-DD. Default today.'),
    },
    async ({ place: query, from, to }, deps) => {
      const p = await deps.places.resolve(query);
      const now = deps.now?.() ?? Date.now();
      const end = to ?? localDate(now, p.timezone);
      const start = from ?? localDate(now - 7 * 86_400_000, p.timezone);
      const span = (Date.parse(end) - Date.parse(start)) / 86_400_000;
      if (!(span >= 0 && span <= 366)) {
        throw new Error('from must be on or before to, at most 366 days apart');
      }
      const station = await stationFor(deps, p);
      if (!station?.climateId) {
        throw new Error(`no reporting climate station near ${p.name}`);
      }
      const climate = await climateDaily(
        deps.upstream,
        station.climateId,
        start,
        end,
      );
      return {
        place: about(p),
        station: climate.station ?? station.name,
        distanceKm: station.distanceKm,
        from: start,
        to: end,
        days: climate.days,
      };
    },
  ),

  op(
    'records',
    'Records and normals',
    "Record highs and lows, and record rain and snow, for a calendar day in a place's long-term climate record, with the month's 1981-2010 normals. Use to judge whether today is unusual.",
    {
      place,
      date: z
        .string()
        .regex(/^(\d{4}-)?\d{2}-\d{2}$/)
        .optional()
        .describe('MM-DD or YYYY-MM-DD. Default today.'),
    },
    async ({ place: query, date }, deps) => {
      const p = await deps.places.resolve(query);
      const day = date ?? localDate(deps.now?.() ?? Date.now(), p.timezone);
      const [month, dom] = day.slice(-5).split('-').map(Number) as [
        number,
        number,
      ];
      const errors: string[] = [];
      const [records, normals] = await Promise.all([
        part('records', errors, () =>
          recordsFor(deps.upstream, p.city, month, dom),
        ),
        part('normals', errors, () =>
          normalsFor(deps.upstream, p.point, month),
        ),
      ]);
      return {
        place: about(p),
        records: records ?? undefined,
        monthlyNormals: normals ?? undefined,
        ...(errors.length > 0 && { errors }),
      };
    },
  ),

  op(
    'air_quality',
    'Air quality',
    'The Air Quality Health Index at the nearest monitoring site: the latest observation and the forecast for the coming hours.',
    { place },
    async ({ place: query }, deps) => {
      const p = await deps.places.resolve(query);
      const aqhi = await airQuality(deps.upstream, p.point);
      if (!aqhi) throw new Error(`no AQHI site near ${p.name}`);
      return localize({ place: about(p), ...aqhi }, p.timezone);
    },
  ),

  op(
    'hurricanes',
    'Tropical storms',
    'Active tropical storms and hurricanes the Canadian Hurricane Centre tracks: position, strength, motion, forecast track, and the distance from each configured place now and at its closest forecast point. Wind in knots.',
    {},
    async (_args, deps) => {
      const storms = await activeStorms(deps.upstream);
      const zone = 'America/Halifax';
      return localize(
        {
          storms: storms.map((storm) => ({
            ...storm,
            distances: deps.places.named.map((named) => {
              const closest = storm.track
                .map((t) => ({
                  time: t.time,
                  km: distanceKm(named.point, t.position),
                }))
                .sort((a, b) => a.km - b.km)[0];
              return {
                place: named.name,
                nowKm: storm.position
                  ? distanceKm(named.point, storm.position)
                  : undefined,
                closestKm: closest?.km,
                closestAt: closest?.time,
              };
            }),
          })),
          note:
            storms.length === 0
              ? 'No active storm is being tracked.'
              : undefined,
        },
        zone,
      );
    },
  ),

  op(
    'marine_forecast',
    'Marine forecast',
    'The Environment Canada marine forecast for the waters nearest a place: winds, visibility, the extended outlook and marine warnings.',
    { place },
    async ({ place: query }, deps) => {
      const p = await deps.places.resolve(query);
      const marine = await marineForecast(deps.upstream, p.point);
      if (!marine) throw new Error(`no marine forecast area near ${p.name}`);
      return localize({ place: about(p), ...marine }, p.timezone);
    },
  ),

  op(
    'burn_restrictions',
    'Nova Scotia burn restrictions',
    "Today's Nova Scotia BurnSafe restriction for each county, or one county (for example Colchester or Halifax).",
    {
      county: z
        .string()
        .max(60)
        .optional()
        .describe('A Nova Scotia county. Omit for all.'),
    },
    async ({ county }, deps) => burnSafe(deps.upstream, county),
  ),
];

export const operationNames = operations.map((o) => o.name);
