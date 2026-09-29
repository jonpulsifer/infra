/**
 * Turns what a person types into a point and its MSC city page: a configured
 * place, a Tempest station, "lat,lon", or any name MSC's city search knows.
 */
import { type Point, parsePoint, zoneForCity } from './geo.ts';
import { type CityRef, nearestCity, searchCities } from './msc.ts';
import type { Tempest } from './tempest.ts';
import type { Upstream } from './upstream.ts';

export interface NamedPlace {
  name: string;
  point: Point;
}

export interface Place {
  name: string;
  point: Point;
  city: CityRef & { distanceKm: number };
  timezone: string;
}

/** "debert=45.363,-63.276;halifax=44.649,-63.602", in the order given. */
export function parsePlaces(value: string): NamedPlace[] {
  const places: NamedPlace[] = [];
  for (const entry of value.split(';')) {
    const at = entry.indexOf('=');
    if (at < 0) continue;
    const name = entry.slice(0, at).trim().toLowerCase();
    const point = parsePoint(entry.slice(at + 1));
    if (!name || !point) {
      throw new Error(
        `WEATHER_PLACES entry "${entry.trim()}" is not name=lat,lon`,
      );
    }
    places.push({ name, point });
  }
  return places;
}

export class PlaceNotFound extends Error {}

export class Places {
  constructor(
    private readonly upstream: Upstream,
    private readonly tempest: Tempest,
    readonly named: readonly NamedPlace[],
  ) {}

  /** No query means the first configured place: home. */
  async resolve(query?: string): Promise<Place> {
    const text = query?.trim() ?? '';
    const key = text.toLowerCase();
    return this.upstream.cached(`place:${key}`, 24 * 3_600_000, async () => {
      const found = await this.locate(text);
      const city = await nearestCity(this.upstream, found.point);
      if (!city) {
        throw new PlaceNotFound(
          `no MSC forecast area near ${found.name}; MSC covers Canada only`,
        );
      }
      return {
        name: found.name,
        point: found.point,
        city,
        timezone: zoneForCity(city.id),
      };
    });
  }

  private async locate(text: string): Promise<NamedPlace> {
    const home = this.named[0];
    if (!text) {
      if (home) return home;
      throw new PlaceNotFound('name a place; WEATHER_PLACES configures none');
    }
    const key = text.toLowerCase();
    const named = this.named.find((p) => p.name === key);
    if (named) return named;
    const station = this.tempest.configured
      ? await this.tempest.find(text)
      : undefined;
    if (station) return { name: station.name, point: station.point };
    const point = parsePoint(text);
    if (point) return { name: text, point };
    const cities = await searchCities(this.upstream, text);
    const city =
      cities.find((c) => c.name.toLowerCase() === key) ??
      cities.find((c) => c.name.toLowerCase().startsWith(key)) ??
      cities[0];
    if (!city) {
      throw new PlaceNotFound(
        `no Canadian place matches "${text}"; try a nearby town or "lat,lon"`,
      );
    }
    return { name: city.name, point: city.point };
  }
}
