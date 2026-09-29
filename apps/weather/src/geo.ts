export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_KM = 6371;

export function distanceKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)) * 10) / 10;
}

/** `minLon,minLat,maxLon,maxLat`, as OGC API bbox wants it. */
export function bbox({ lat, lon }: Point, degrees: number): string {
  const r = (n: number) => Math.round(n * 1e4) / 1e4;
  return [lon - degrees, lat - degrees, lon + degrees, lat + degrees]
    .map(r)
    .join(',');
}

/** "45.36,-63.28" or "45.36, -63.28"; anything else is null. */
export function parsePoint(text: string): Point | null {
  const match = text
    .trim()
    .match(/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Province of the MSC city page id to its main zone. Parts of Ontario, Quebec,
// BC, Saskatchewan and Nunavut differ; times are labelled, so a wrong zone
// shifts the label and never the instant.
const ZONES: Record<string, string> = {
  nl: 'America/St_Johns',
  ns: 'America/Halifax',
  nb: 'America/Moncton',
  pe: 'America/Halifax',
  qc: 'America/Toronto',
  on: 'America/Toronto',
  mb: 'America/Winnipeg',
  sk: 'America/Regina',
  ab: 'America/Edmonton',
  bc: 'America/Vancouver',
  yt: 'America/Whitehorse',
  nt: 'America/Yellowknife',
  nu: 'America/Iqaluit',
};

export function zoneForCity(cityId: string): string {
  return ZONES[cityId.split('-')[0]?.toLowerCase() ?? ''] ?? 'America/Toronto';
}

/** "2026-09-29 19:00 ADT": what a person reads, with the zone named. */
export function localTime(
  instant: string | number | undefined | null,
  zone: string,
): string | undefined {
  if (instant == null || instant === '') return undefined;
  const date = new Date(typeof instant === 'number' ? instant * 1000 : instant);
  if (Number.isNaN(date.getTime())) return undefined;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'short',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/** The calendar date at `zone`, as YYYY-MM-DD. */
export function localDate(instant: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(
    new Date(instant),
  );
}
