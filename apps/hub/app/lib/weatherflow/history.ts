// Turning raw device observations into the rolling 24h window the display
// shows. Pure: the fetching lives in weather.server.ts.
//
// `/observations/device/{id}` returns positional arrays rather than objects,
// and the field order depends on which device reported. A Tempest (ST) covers
// every metric on its own; the older two-piece stations split them across an
// AIR (temperature, humidity, pressure) and a SKY (wind, sun, rain), so a
// station can need both and the samples below are merged from both devices.
import { WEATHERFLOW_CONFIG } from './config';
import type {
  DeviceObsResponse,
  HistoryField,
  MetricExtremes,
  StationHistory,
} from './types';
import { HISTORY_FIELDS } from './types';

/** One decoded device observation. Every metric is optional: an AIR row
 * carries no wind, a SKY row no temperature. */
export type HistorySample = { timestamp: number } & Partial<
  Record<HistoryField | 'rainAccum', number>
>;

type Layout = Partial<Record<HistoryField | 'rainAccum', number>>;

// Index maps from the API's observation record format. `rainAccum` is the
// accumulation *for that reporting interval*, so summing it across the window
// gives rain over the last 24h - which is what the display wants, and not the
// same thing as the local-day total the latest observation reports.
const OBS_LAYOUTS: Record<string, Layout> = {
  obs_st: {
    windSpeed: 2,
    windGust: 3,
    pressure: 6,
    temperature: 7,
    humidity: 8,
    illuminance: 9,
    uvIndex: 10,
    solarRadiation: 11,
    rainAccum: 12,
  },
  obs_air: {
    pressure: 1,
    temperature: 2,
    humidity: 3,
  },
  obs_sky: {
    illuminance: 1,
    uvIndex: 2,
    rainAccum: 3,
    windSpeed: 5,
    windGust: 6,
    solarRadiation: 10,
  },
};

/**
 * Decode one device-observation response. An unrecognised `type` yields no
 * samples rather than throwing: a device the API grows a new record format for
 * should leave the window thinner, not break the whole poll.
 */
export function decodeDeviceObs(res: DeviceObsResponse): HistorySample[] {
  const layout = res.type ? OBS_LAYOUTS[res.type] : undefined;
  if (!layout || !res.obs) return [];

  const samples: HistorySample[] = [];
  for (const row of res.obs) {
    const timestamp = row[0];
    if (typeof timestamp !== 'number') continue;
    const sample: HistorySample = { timestamp };
    for (const [field, index] of Object.entries(layout)) {
      const value = row[index];
      if (typeof value === 'number' && Number.isFinite(value)) {
        sample[field as HistoryField | 'rainAccum'] = value;
      }
    }
    samples.push(sample);
  }
  return samples;
}

function extremesFor(
  samples: HistorySample[],
  field: HistoryField,
): MetricExtremes | undefined {
  let found: MetricExtremes | undefined;
  for (const sample of samples) {
    const value = sample[field];
    if (value == null) continue;
    if (!found) {
      found = {
        min: value,
        minAt: sample.timestamp,
        max: value,
        maxAt: sample.timestamp,
      };
      continue;
    }
    if (value < found.min) {
      found.min = value;
      found.minAt = sample.timestamp;
    }
    if (value > found.max) {
      found.max = value;
      found.maxAt = sample.timestamp;
    }
  }
  return found;
}

/**
 * Reduce the temperature series to `count` evenly-spaced buckets, averaging
 * within each. The buckets holding the window's true low and high are then
 * pinned to those values: the sparkline is drawn with the same low/high the
 * panel labels, and a curve that visibly stopped short of its own stated high
 * reads as a bug.
 */
function downsample(
  points: Array<[number, number]>,
  count: number,
  extremes: MetricExtremes | undefined,
): Array<[number, number]> {
  if (points.length <= count) return points;

  const from = points[0][0];
  const to = points[points.length - 1][0];
  const step = (to - from) / count || 1;

  const sums = new Array<number>(count).fill(0);
  const counts = new Array<number>(count).fill(0);
  for (const [at, value] of points) {
    const bucket = Math.min(count - 1, Math.floor((at - from) / step));
    sums[bucket] += value;
    counts[bucket] += 1;
  }

  const bucketOf = (at: number) =>
    Math.min(count - 1, Math.max(0, Math.floor((at - from) / step)));
  const pinned = new Map<number, number>();
  if (extremes) {
    pinned.set(bucketOf(extremes.minAt), extremes.min);
    pinned.set(bucketOf(extremes.maxAt), extremes.max);
  }

  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    if (counts[i] === 0) continue;
    const at = Math.round(from + (i + 0.5) * step);
    const value = pinned.get(i) ?? sums[i] / counts[i];
    out.push([at, Number(value.toFixed(2))]);
  }
  return out;
}

/**
 * Build the window from every device's samples. Returns undefined when nothing
 * falls inside it, which keeps the caller's previous (still valid) window in
 * place rather than replacing it with an empty one.
 */
export function buildHistory(
  samples: HistorySample[],
  now: number = Date.now(),
): StationHistory | undefined {
  const cutoff = now / 1000 - WEATHERFLOW_CONFIG.HISTORY_WINDOW;
  const inWindow = samples
    .filter((s) => s.timestamp >= cutoff)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (inWindow.length === 0) return undefined;

  const extremes: StationHistory['extremes'] = {};
  for (const field of HISTORY_FIELDS) {
    const found = extremesFor(inWindow, field);
    if (found) extremes[field] = found;
  }

  let rainTotal: number | undefined;
  for (const sample of inWindow) {
    if (sample.rainAccum == null) continue;
    rainTotal = (rainTotal ?? 0) + sample.rainAccum;
  }

  const temperaturePoints = inWindow
    .filter((s) => s.temperature != null)
    .map((s) => [s.timestamp, s.temperature as number] as [number, number]);

  return {
    from: inWindow[0].timestamp,
    to: inWindow[inWindow.length - 1].timestamp,
    samples: inWindow.length,
    extremes,
    temperature: downsample(
      temperaturePoints,
      WEATHERFLOW_CONFIG.HISTORY_POINTS,
      extremes.temperature,
    ),
    rainTotal: rainTotal == null ? undefined : Number(rainTotal.toFixed(2)),
  };
}
