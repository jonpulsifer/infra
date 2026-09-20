import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CloudRain,
  Droplets,
  Gauge,
  Lightbulb,
  Sun,
  Wind,
  X,
  Zap,
} from 'lucide-react';
import { clockTimeFromEpochSeconds } from '~/lib/format-time';
import type { LeaderMap } from '~/lib/weatherflow/leader';
import type {
  StationHistory,
  StationObservation,
} from '~/lib/weatherflow/types';
import { MetricCell } from './metric-cell';
import { RangeBar } from './range-bar';
import { Sparkline } from './sparkline';

interface StationDisplayProps {
  label: string;
  observation: StationObservation | null;
  history?: StationHistory;
  now: number; // ms epoch, ticks from the dashboard clock
  index: number; // this station's position in the compared group
  accent: string; // this station's identity colour
  leaders: LeaderMap; // per-metric leading station index
  tempDelta?: number | null; // signed °C vs the other station (2-station mode)
  otherName?: string; // the station tempDelta is measured against
  onRemove?: () => void; // dev-only per-panel remove affordance
}

const WIND_DIRECTIONS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];

const SKELETON_CELLS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

const MS_PER_SECOND = 1000;

function windDirection(degrees?: number): string | undefined {
  if (degrees == null) return undefined;
  return WIND_DIRECTIONS[Math.round(degrees / 22.5) % 16];
}

/**
 * Plain-language freshness for the panel header: a colored dot plus the
 * observation time. Green under 3 minutes old, amber under 10, "Stale" beyond.
 */
function getFreshness(
  obsTimestamp: number | undefined,
  now: number,
): { dotClass: string; text: string } {
  if (obsTimestamp == null) {
    return { dotClass: 'bg-slate-500', text: 'No data' };
  }
  const ageMinutes = (now / MS_PER_SECOND - obsTimestamp) / 60;
  const updated = clockTimeFromEpochSeconds(obsTimestamp);
  if (ageMinutes < 3) {
    return { dotClass: 'bg-emerald-400', text: `Updated ${updated}` };
  }
  if (ageMinutes < 10) {
    return { dotClass: 'bg-amber-400', text: `Updated ${updated}` };
  }
  return { dotClass: 'bg-red-400', text: `Stale ${updated}` };
}

function trendIcon(trend?: string) {
  const cls = 'w-3.5 h-3.5';
  switch (trend) {
    case 'rising':
      return <ArrowUp className={`${cls} text-emerald-400`} />;
    case 'falling':
      return <ArrowDown className={`${cls} text-red-400`} />;
    default:
      return <ArrowRight className={`${cls} text-slate-500`} />;
  }
}

const ICON = 'w-3.5 h-3.5 text-slate-500 shrink-0';

const degrees = (value: number) => `${value.toFixed(1)}°`;

export function StationDisplay({
  label,
  observation,
  history,
  now,
  index,
  accent,
  leaders,
  tempDelta = null,
  otherName,
  onRemove,
}: StationDisplayProps) {
  const obs = observation ?? {};
  const windKmh = obs.windSpeed != null ? obs.windSpeed * 3.6 : undefined;
  const gustKmh = obs.windGust != null ? obs.windGust * 3.6 : undefined;
  const freshness = getFreshness(obs.timestamp, now);
  const leads = (field: keyof LeaderMap) => leaders[field] === index;
  const range = history?.extremes;

  // The history window records wind in m/s, like the observation; the panel
  // shows km/h, so the range has to travel through the same conversion.
  const kmhRange = (field: 'windSpeed' | 'windGust') => {
    const extremes = range?.[field];
    if (!extremes) return undefined;
    return {
      ...extremes,
      min: extremes.min * 3.6,
      max: extremes.max * 3.6,
    };
  };

  const dir = windDirection(obs.windDirection);

  const header = (
    <div className="flex shrink-0 items-center justify-between gap-2">
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: accent }}
        />
        <span className="truncate text-[0.95rem] font-bold">{label}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${freshness.dotClass}`}
          aria-hidden="true"
        />
        <span className="whitespace-nowrap text-[0.6rem] font-semibold uppercase tracking-wide text-slate-500">
          {freshness.text}
        </span>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${label}`}
            className="-mr-1 rounded p-0.5 text-slate-500 transition-colors hover:bg-red-900/20 hover:text-red-400"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </span>
    </div>
  );

  // Skeleton while a discovered station has no observation yet
  if (observation == null) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 bg-[#10151d] p-3.5 sm:p-4">
        {header}
        <div className="h-14 w-28 animate-pulse rounded bg-white/5" />
        <div className="h-2.5 animate-pulse rounded-full bg-white/5" />
        <div className="h-16 animate-pulse rounded bg-white/5" />
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
          {SKELETON_CELLS.map((cell) => (
            <div key={cell} className="h-10 animate-pulse rounded bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5 bg-[#10151d] p-3.5 sm:p-4">
      {header}

      <div className="flex shrink-0 items-end gap-3">
        <span className="text-[3.6rem] font-extrabold leading-[0.82] tracking-tight tabular-nums text-white sm:text-[3.4rem]">
          {obs.temperature != null ? obs.temperature.toFixed(1) : '--'}°
        </span>
        <div className="flex flex-col gap-1 pb-1.5">
          {obs.feelsLike != null && (
            <span className="text-[0.72rem] font-semibold text-slate-400">
              Feels {obs.feelsLike.toFixed(1)}°
            </span>
          )}
          {tempDelta != null && (
            <span
              className="text-[0.72rem] font-semibold tabular-nums"
              style={{ color: accent }}
            >
              {Math.abs(tempDelta).toFixed(1)}°{' '}
              {tempDelta < 0 ? 'cooler' : 'warmer'}
              {otherName ? ` than ${otherName}` : ''}
            </span>
          )}
        </div>
      </div>

      {range?.temperature ? (
        <RangeBar
          extremes={range.temperature}
          value={obs.temperature}
          format={degrees}
        />
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="text-[0.6rem] font-semibold uppercase tracking-[0.1em] text-slate-500">
            Last 24h
          </span>
          <div className="h-2.5 rounded-full bg-white/[0.06]" />
          <span className="text-[0.6rem] text-slate-600">
            Waiting for history
          </span>
        </div>
      )}

      <Sparkline
        points={history?.temperature ?? []}
        extremes={range?.temperature}
        accent={accent}
        gradientId={`spark-${index}`}
        label={`${label} temperature over the last 24 hours`}
        className="h-24 sm:h-auto sm:max-h-48 sm:min-h-12 sm:flex-1"
      />

      <div className="mt-auto grid shrink-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <MetricCell
          icon={<Droplets className={ICON} />}
          label="Humidity"
          isLeader={leads('humidity')}
          value={obs.humidity}
          unit="%"
          decimals={0}
          showUnitWhenEmpty
          range={range?.humidity}
        />
        <MetricCell
          icon={<Wind className={ICON} />}
          label={dir ? `Wind ${dir}` : 'Wind'}
          isLeader={leads('windSpeed')}
          value={windKmh}
          unit={windKmh === 0 ? '' : 'km/h'}
          decimals={1}
          displayText={windKmh === 0 ? 'Calm' : undefined}
          range={kmhRange('windSpeed')}
        />
        <MetricCell
          icon={<Wind className={ICON} />}
          label="Gust"
          isLeader={leads('windGust')}
          value={gustKmh}
          unit="km/h"
          decimals={1}
          range={kmhRange('windGust')}
        />
        <MetricCell
          icon={<Gauge className={ICON} />}
          label="Pressure"
          isLeader={leads('pressure')}
          value={obs.pressure}
          unit="mb"
          decimals={0}
          trailing={trendIcon(obs.barometricTrend)}
          range={range?.pressure}
        />
        <MetricCell
          icon={<CloudRain className={ICON} />}
          label={history?.rainTotal != null ? 'Rain 24h' : 'Rain today'}
          isLeader={leads('rainTotal')}
          value={history?.rainTotal ?? obs.rainTotal}
          unit="mm"
          decimals={1}
        />
        <MetricCell
          icon={<Sun className={ICON} />}
          label="UV index"
          isLeader={leads('uvIndex')}
          value={obs.uvIndex}
          decimals={1}
          range={range?.uvIndex}
        />
        <MetricCell
          icon={<Zap className={ICON} />}
          label="Solar"
          isLeader={leads('solarRadiation')}
          value={obs.solarRadiation}
          unit="W/m²"
          decimals={0}
          range={range?.solarRadiation}
        />
        <MetricCell
          icon={<Lightbulb className={ICON} />}
          label="Light"
          isLeader={leads('illuminance')}
          value={obs.illuminance}
          unit="lux"
          decimals={0}
          locale
          range={range?.illuminance}
        />
      </div>
    </div>
  );
}
