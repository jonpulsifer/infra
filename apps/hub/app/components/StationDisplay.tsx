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
import type { LeaderMap } from '~/lib/weatherflow/leader';
import type { StationObservation } from '~/lib/weatherflow/types';
import { MetricRow } from './metric-row';

interface StationDisplayProps {
  label: string;
  observation: StationObservation | null;
  now: number; // ms epoch, ticks from the dashboard clock
  index: number; // this station's position in the compared group
  leaders: LeaderMap; // per-metric leading station index
  isWarmest?: boolean; // this station holds the highest temperature
  tempDelta?: number | null; // signed °C vs the other station (2-station mode)
  solo?: boolean; // single-station "big display" mode
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

const SKELETON_ROWS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];

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
  const ageMinutes = (now / 1000 - obsTimestamp) / 60;
  const updated = new Date(obsTimestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
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

const ICON = 'w-4 h-4 text-slate-500 shrink-0';

export function StationDisplay({
  label,
  observation,
  now,
  index,
  leaders,
  isWarmest = false,
  tempDelta = null,
  solo = false,
  onRemove,
}: StationDisplayProps) {
  const obs = observation ?? {};
  const windKmh = obs.windSpeed != null ? obs.windSpeed * 3.6 : undefined;
  const gustKmh = obs.windGust != null ? obs.windGust * 3.6 : undefined;
  const freshness = getFreshness(obs.timestamp, now);
  const leads = (field: keyof LeaderMap) => leaders[field] === index;

  const dir = windDirection(obs.windDirection);
  const windSub = [dir, gustKmh != null ? `gust ${gustKmh.toFixed(1)}` : null]
    .filter(Boolean)
    .join(' · ');

  const removeButton = onRemove ? (
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${label}`}
      className="p-0.5 -mr-1 rounded text-slate-500 hover:text-red-400 hover:bg-red-900/20 transition-colors"
    >
      <X className="w-4 h-4" />
    </button>
  ) : null;

  const header = (
    <div className="flex items-center justify-between gap-2 py-2.5 shrink-0">
      <span className="text-[0.95rem] font-bold truncate">{label}</span>
      <div className="flex items-center gap-1.5 shrink-0">
        <span
          className={`w-1.5 h-1.5 rounded-full ${freshness.dotClass}`}
          aria-hidden="true"
        />
        <span className="text-[0.6rem] uppercase tracking-wide text-slate-500 font-semibold whitespace-nowrap">
          {freshness.text}
        </span>
        {removeButton}
      </div>
    </div>
  );

  // Skeleton while a discovered station has no observation yet
  if (observation == null) {
    return (
      <div className="flex-1 min-w-0 flex flex-col bg-[#10151d] px-4">
        {header}
        <div className="flex items-end gap-2.5 pb-2.5 border-b border-white/[0.07]">
          <div className="h-14 w-28 bg-white/5 rounded animate-pulse" />
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          {SKELETON_ROWS.map((row) => (
            <div
              key={row}
              className="flex-1 min-h-[2.1rem] flex items-center justify-between border-b border-white/[0.07] last:border-b-0"
            >
              <div className="h-3 w-20 bg-white/5 rounded animate-pulse" />
              <div className="h-4 w-12 bg-white/5 rounded animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const metrics = (
    <>
      <MetricRow
        icon={<Droplets className={ICON} />}
        label="Humidity"
        isLeader={leads('humidity')}
        value={obs.humidity}
        unit="%"
        decimals={0}
        showUnitWhenEmpty
      />
      <MetricRow
        icon={<Wind className={ICON} />}
        label="Wind"
        sub={windSub || undefined}
        isLeader={leads('windSpeed')}
        value={windKmh}
        unit={windKmh === 0 ? '' : 'km/h'}
        decimals={1}
        displayText={windKmh === 0 ? 'Calm' : undefined}
      />
      <MetricRow
        icon={<Gauge className={ICON} />}
        label="Pressure"
        isLeader={leads('pressure')}
        value={obs.pressure}
        unit="mb"
        decimals={0}
        trailing={trendIcon(obs.barometricTrend)}
      />
      <MetricRow
        icon={<CloudRain className={ICON} />}
        label="Rain"
        isLeader={leads('rainTotal')}
        value={obs.rainTotal}
        unit="mm"
        decimals={1}
      />
      <MetricRow
        icon={<Sun className={ICON} />}
        label="UV index"
        isLeader={leads('uvIndex')}
        value={obs.uvIndex}
        decimals={1}
      />
      <MetricRow
        icon={<Zap className={ICON} />}
        label="Solar"
        isLeader={leads('solarRadiation')}
        value={obs.solarRadiation}
        unit="W/m²"
        decimals={0}
      />
      <MetricRow
        icon={<Lightbulb className={ICON} />}
        label="Light"
        isLeader={leads('illuminance')}
        value={obs.illuminance}
        unit="lux"
        decimals={0}
        locale
      />
    </>
  );

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-[#10151d] px-4">
      {header}

      {/* Temperature */}
      <div className="flex items-end gap-2.5 pb-2.5 border-b border-white/[0.07] shrink-0">
        <span
          className={`${
            solo ? 'text-[6.5rem]' : 'text-[3.4rem]'
          } font-extrabold leading-[0.82] tracking-tight tabular-nums ${
            isWarmest ? 'text-sky-400' : 'text-white'
          }`}
        >
          {obs.temperature != null ? obs.temperature.toFixed(1) : '--'}°
        </span>
        <div className="flex flex-col gap-0.5 pb-1">
          {tempDelta != null && (
            <span
              className={`text-[0.72rem] font-semibold tabular-nums ${
                tempDelta < 0 ? 'text-slate-500' : 'text-sky-400'
              }`}
            >
              {tempDelta > 0 ? '+' : ''}
              {tempDelta.toFixed(1)}° vs other
            </span>
          )}
          {obs.feelsLike != null && (
            <span className="text-[0.7rem] text-slate-400 font-semibold">
              Feels {obs.feelsLike.toFixed(1)}°
            </span>
          )}
        </div>
      </div>

      {/* Metrics fill the remaining height */}
      <div
        className={
          solo
            ? 'flex-1 grid grid-cols-2 gap-x-6 content-center'
            : 'flex-1 flex flex-col min-h-0'
        }
      >
        {metrics}
      </div>
    </div>
  );
}
