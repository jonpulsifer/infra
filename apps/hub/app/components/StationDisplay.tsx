import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CloudRain,
  Compass,
  Droplets,
  Eye,
  Sun,
  Thermometer,
  Wind,
  Zap,
} from 'lucide-react';
import type { StationObservation } from '~/lib/weatherflow/types';
import { formatMetricNumber, getDiffColorClass, MetricRow } from './metric-row';

interface StationDisplayProps {
  label: string;
  observation: StationObservation | null;
  isDiff?: boolean;
  now: number; // ms epoch, ticks from the dashboard clock
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

const SKELETON_ROWS = [
  'humidity',
  'wind',
  'pressure',
  'rain',
  'uv',
  'lull',
  'gust',
  'solar',
];

function getWindDirectionLabel(degrees?: number): string {
  if (degrees == null) return '--';
  const index = Math.round(degrees / 22.5) % 16;
  return `${WIND_DIRECTIONS[index]} ${degrees.toFixed(0)}°`;
}

/**
 * Plain-language freshness for the station header: a colored dot plus the
 * observation time. Green under 3 minutes old, amber under 10, "Stale" beyond.
 */
function getFreshness(
  obsTimestamp: number | undefined,
  now: number,
): { dotClass: string; text: string } {
  if (obsTimestamp == null) {
    return { dotClass: 'bg-gray-500', text: 'No data' };
  }
  const ageMinutes = (now / 1000 - obsTimestamp) / 60;
  const updated = new Date(obsTimestamp * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (ageMinutes < 3) {
    return { dotClass: 'bg-green-400', text: `Updated ${updated}` };
  }
  if (ageMinutes < 10) {
    return { dotClass: 'bg-yellow-400', text: `Updated ${updated}` };
  }
  return { dotClass: 'bg-red-400', text: `Stale — last update ${updated}` };
}

function getBarometricTrendIcon(trend?: string) {
  switch (trend) {
    case 'rising':
      return <ArrowUp className="w-4 h-4 text-green-400" />;
    case 'falling':
      return <ArrowDown className="w-4 h-4 text-red-400" />;
    default:
      return <ArrowRight className="w-4 h-4 text-gray-400" />;
  }
}

export function StationDisplay({
  label,
  observation,
  isDiff = false,
  now,
}: StationDisplayProps) {
  const obs = observation ?? {};
  const tempC = obs.temperature;
  const feelsLike = obs.feelsLike;
  const windAvgKmh = obs.windSpeed != null ? obs.windSpeed * 3.6 : undefined;
  const windLullKmh = obs.windLull != null ? obs.windLull * 3.6 : undefined;
  const windGustKmh = obs.windGust != null ? obs.windGust * 3.6 : undefined;
  const freshness = getFreshness(obs.timestamp, now);

  // Skeleton while a discovered station has no observation yet
  if (!isDiff && observation == null) {
    return (
      <div className="flex flex-col h-full border-r border-gray-700 last:border-r-0 overflow-hidden flex-1">
        <div className="flex items-center justify-between px-2 py-1 border-b border-gray-700 flex-shrink-0 h-[2.25rem]">
          <span className="text-gray-300 font-bold text-base whitespace-nowrap">
            {label}
          </span>
          <div className="h-3 w-16 bg-gray-800 rounded animate-pulse" />
        </div>
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="flex flex-col items-center justify-center py-1 border-b border-gray-800 flex-shrink-0 h-24">
            <div className="h-10 w-32 bg-gray-800 rounded animate-pulse mb-2" />
            <div className="h-3 w-20 bg-gray-800 rounded animate-pulse" />
          </div>
          <div className="flex-1 flex flex-col overflow-hidden min-h-0">
            {SKELETON_ROWS.map((row) => (
              <div
                key={row}
                className="flex items-center justify-between px-2 py-0.5 border-b border-gray-800 flex-shrink-0 min-h-[1.75rem]"
              >
                <div className="h-3 w-16 bg-gray-800 rounded animate-pulse" />
                <div className="h-4 w-12 bg-gray-800 rounded animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`flex flex-col h-full border-r border-gray-700 last:border-r-0 overflow-hidden ${isDiff ? 'flex-[0.5]' : 'flex-1'}`}
    >
      {/* Station Header */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-gray-700 flex-shrink-0 h-[2.25rem]">
        {isDiff ? (
          <div className="flex items-center justify-center gap-2 text-xs w-full">
            <span className="text-gray-300 font-bold text-base whitespace-nowrap">
              {label}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 text-xs w-full">
            <span className="text-gray-300 font-bold text-base whitespace-nowrap">
              {label}
            </span>
            <div className="flex items-center gap-1.5">
              <span
                className={`w-2 h-2 rounded-full ${freshness.dotClass}`}
                aria-hidden="true"
              />
              <span className="text-gray-500 text-[10px]">
                {freshness.text}
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Weather Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {/* Temperature - Large */}
        <div className="flex flex-col items-center justify-center py-1 border-b border-gray-800 flex-shrink-0">
          <div className="flex items-center">
            <Thermometer className="w-4 h-4 text-orange-400 mr-2" />
            <div
              className={`text-4xl font-bold ${getDiffColorClass(tempC, isDiff)}`}
            >
              {formatMetricNumber(tempC, {
                decimals: 1,
                unit: '°',
                isDiff,
                showUnitWhenEmpty: true,
              })}
            </div>
          </div>
          <div className="h-3 flex items-center justify-center">
            {feelsLike != null &&
            Math.abs(feelsLike - (tempC ?? 0)) > 2 &&
            !isDiff ? (
              <div className="text-xs text-gray-400">
                Feels like {feelsLike.toFixed(1)}°
              </div>
            ) : null}
          </div>
        </div>

        {/* Weather Details Grid */}
        <div className="flex-1 overflow-hidden min-h-0 flex flex-col">
          <MetricRow
            icon={<Droplets className="w-4 h-4 text-blue-400" />}
            label="Humidity"
            isDiff={isDiff}
            value={obs.humidity}
            unit="%"
            decimals={0}
            showUnitWhenEmpty
          />

          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-400" />}
            label="Wind Avg"
            isDiff={isDiff}
            value={windAvgKmh}
            displayText={
              windAvgKmh != null && windAvgKmh !== 0
                ? formatMetricNumber(windAvgKmh, {
                    decimals: 1,
                    unit: ' km/h',
                    isDiff,
                  })
                : windAvgKmh === 0 && isDiff
                  ? '0 km/h'
                  : 'Windless'
            }
          />

          <MetricRow
            icon={<Eye className="w-4 h-4 text-purple-400" />}
            label="Pressure"
            isDiff={isDiff}
            value={obs.pressure}
            decimals={0}
            trailing={
              <>
                <span className="text-xs text-gray-500">mb</span>
                {!isDiff && getBarometricTrendIcon(obs.barometricTrend)}
              </>
            }
          />

          <MetricRow
            icon={<CloudRain className="w-4 h-4 text-blue-400" />}
            label="Rain"
            isDiff={isDiff}
            value={obs.rainTotal}
            unit=" mm"
            decimals={1}
            undefinedClassName="text-gray-500"
          />

          <MetricRow
            icon={<Sun className="w-4 h-4 text-yellow-400" />}
            label="UV"
            isDiff={isDiff}
            value={obs.uvIndex}
            decimals={1}
          />

          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-500" />}
            label="Wind Lull"
            isDiff={isDiff}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={windLullKmh}
            unit=" km/h"
            decimals={1}
          />

          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-500" />}
            label="Wind Gust"
            isDiff={isDiff}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={windGustKmh}
            unit=" km/h"
            decimals={1}
          />

          <MetricRow
            icon={<Compass className="w-4 h-4 text-gray-400" />}
            label="Direction"
            isDiff={isDiff}
            weight="semibold"
            displayText={getWindDirectionLabel(obs.windDirection)}
          />

          <MetricRow
            icon={<Zap className="w-4 h-4 text-yellow-300" />}
            label="Solar"
            isDiff={isDiff}
            weight="semibold"
            neutralClassName="text-white"
            undefinedClassName="text-gray-500"
            value={obs.solarRadiation}
            unit=" W/m²"
            decimals={0}
          />

          <MetricRow
            icon={<Sun className="w-4 h-4 text-gray-500" />}
            label="Light"
            isDiff={isDiff}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={obs.illuminance}
            unit=" lux"
            decimals={0}
          />
        </div>
      </div>
    </div>
  );
}
