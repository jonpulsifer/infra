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
import type {
  ConnectionStatus,
  WeatherData,
  WebSocketState,
} from '~/lib/weatherflow/types';
import { formatMetricNumber, getDiffColorClass, MetricRow } from './metric-row';

interface StationDisplayProps {
  stationLabel: string;
  weatherData: WeatherData;
  connectionStatus: ConnectionStatus;
  lastUpdate: number | null;
  isSingleStation?: boolean;
  isDiff?: boolean; // If true, this is showing differences
  websocketStatus?: WebSocketState;
  sseStatus?: 'connected' | 'connecting' | 'disconnected';
}

export function StationDisplay({
  stationLabel,
  weatherData,
  connectionStatus: _connectionStatus,
  lastUpdate,
  isSingleStation = false,
  isDiff = false,
  websocketStatus,
  sseStatus,
}: StationDisplayProps) {
  const tempC = weatherData?.temperature;
  const feelsLike = weatherData?.feelsLike;
  const windAvgKmh =
    weatherData?.windSpeed != null ? weatherData.windSpeed * 3.6 : undefined;
  const windLullKmh =
    weatherData?.windLull != null ? weatherData.windLull * 3.6 : undefined;
  const windGustKmh =
    weatherData?.windGust != null ? weatherData.windGust * 3.6 : undefined;
  const windDirection = weatherData?.windDirection;
  const barometricTrend = weatherData?.barometricTrend || 'steady';

  const getBarometricTrendIcon = (trend: string) => {
    switch (trend) {
      case 'rising':
        return <ArrowUp className="w-4 h-4 text-green-400" />;
      case 'falling':
        return <ArrowDown className="w-4 h-4 text-red-400" />;
      default:
        return <ArrowRight className="w-4 h-4 text-gray-400" />;
    }
  };

  const getWindDirectionLabel = (degrees?: number): string => {
    if (degrees === undefined || degrees === null) return '--';
    const directions = [
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
    const index = Math.round(degrees / 22.5) % 16;
    return `${directions[index]} ${degrees.toFixed(0)}°`;
  };

  const getStatusColor = (status: WebSocketState | string) => {
    switch (status) {
      case 'connected':
        return 'text-green-400';
      case 'connecting':
      case 'reconnecting':
        return 'text-yellow-400';
      case 'error':
        return 'text-red-400';
      default:
        return 'text-gray-400';
    }
  };

  const getSseStatusColor = (status: string) => {
    switch (status) {
      case 'connected':
        return 'text-green-400';
      case 'connecting':
        return 'text-yellow-400';
      default:
        return 'text-gray-400';
    }
  };

  const wsStatus = websocketStatus || 'disconnected';
  const displaySseStatus = sseStatus || 'disconnected';

  // Show skeleton if we are connecting/connected but have no data yet
  const showSkeleton =
    !isDiff &&
    (displaySseStatus === 'connecting' || displaySseStatus === 'connected') &&
    weatherData.temperature === undefined;

  if (showSkeleton) {
    return (
      <div
        className={`flex flex-col h-full border-r border-gray-700 last:border-r-0 overflow-hidden ${isDiff ? 'flex-[0.5]' : 'flex-1'}`}
      >
        {/* Header Skeleton */}
        <div className="flex items-center justify-between px-2 py-1 border-b border-gray-700 flex-shrink-0 h-[2.25rem]">
          <div className="flex items-center gap-2 w-full">
            <div className="h-4 w-24 bg-gray-800 rounded animate-pulse" />
          </div>
          <div className="flex items-center gap-1.5 ml-auto">
            <div className="h-3 w-10 bg-gray-800 rounded animate-pulse" />
            <div className="h-3 w-10 bg-gray-800 rounded animate-pulse" />
          </div>
        </div>

        {/* Content Skeleton */}
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Temperature Skeleton */}
          <div className="flex flex-col items-center justify-center py-1 border-b border-gray-800 flex-shrink-0 h-24">
            <div className="h-10 w-32 bg-gray-800 rounded animate-pulse mb-2" />
            <div className="h-3 w-20 bg-gray-800 rounded animate-pulse" />
          </div>

          {/* Grid Skeleton */}
          <div
            className={`flex-1 overflow-hidden min-h-0 ${isSingleStation ? 'grid grid-cols-2' : 'flex flex-col'}`}
          >
            {[...Array(8)].map((_, i) => (
              <div
                key={i}
                className={`flex items-center justify-between px-2 py-0.5 border-b border-gray-800 ${isSingleStation ? 'border-r border-r-gray-800' : ''} flex-shrink-0 min-h-[1.75rem]`}
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
              {stationLabel}
            </span>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2 text-xs w-full">
            <div className="flex items-center gap-2">
              <span className="text-gray-300 font-bold text-base whitespace-nowrap">
                {stationLabel}
              </span>
              {lastUpdate && (
                <span className="text-gray-500 text-[10px]">
                  {new Date(lastUpdate).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 ml-auto">
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-gray-700 bg-gray-800/50"
                title={`WebSocket: ${wsStatus}`}
              >
                <span className="text-gray-500">WS</span>
                <span className={`${getStatusColor(wsStatus)} text-[10px]`}>
                  {wsStatus === 'connected'
                    ? '●'
                    : wsStatus === 'reconnecting'
                      ? '↻'
                      : wsStatus === 'connecting'
                        ? '···'
                        : wsStatus === 'error'
                          ? '!'
                          : '○'}
                </span>
              </div>
              <div
                className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-gray-700 bg-gray-800/50"
                title={`Server-Sent Events: ${displaySseStatus}`}
              >
                <span className="text-gray-500">SSE</span>
                <span
                  className={`${getSseStatusColor(displaySseStatus)} text-[10px]`}
                >
                  {displaySseStatus === 'connected'
                    ? '●'
                    : displaySseStatus === 'connecting'
                      ? '···'
                      : '○'}
                </span>
              </div>
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

        {/* Weather Details Grid - 2x2 when single station, single column when multiple */}
        <div
          className={`flex-1 overflow-hidden min-h-0 ${isSingleStation ? 'grid grid-cols-2' : 'flex flex-col'}`}
        >
          {/* Humidity */}
          <MetricRow
            icon={<Droplets className="w-4 h-4 text-blue-400" />}
            label="Humidity"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            value={weatherData?.humidity}
            unit="%"
            decimals={0}
            showUnitWhenEmpty
          />

          {/* Wind - Avg */}
          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-400" />}
            label="Wind Avg"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
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

          {/* Pressure */}
          <MetricRow
            icon={<Eye className="w-4 h-4 text-purple-400" />}
            label="Pressure"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            value={weatherData?.pressure}
            decimals={0}
            trailing={
              <>
                <span className="text-xs text-gray-500">mb</span>
                {!isDiff && getBarometricTrendIcon(barometricTrend)}
              </>
            }
          />

          {/* Rain */}
          <MetricRow
            icon={<CloudRain className="w-4 h-4 text-blue-400" />}
            label="Rain"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            value={weatherData?.rainTotal}
            unit=" mm"
            decimals={1}
            undefinedClassName="text-gray-500"
          />

          {/* UV Index */}
          <MetricRow
            icon={<Sun className="w-4 h-4 text-yellow-400" />}
            label="UV"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            value={weatherData?.uvIndex}
            decimals={1}
          />

          {/* Wind - Lull - Always render for alignment */}
          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-500" />}
            label="Wind Lull"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={windLullKmh}
            unit=" km/h"
            decimals={1}
          />

          {/* Wind - Gust - Always render for alignment */}
          <MetricRow
            icon={<Wind className="w-4 h-4 text-gray-500" />}
            label="Wind Gust"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={windGustKmh}
            unit=" km/h"
            decimals={1}
          />

          {/* Wind Direction - Always render for alignment */}
          <div
            className={`flex items-center justify-between px-2 py-0.5 border-b border-gray-800 ${isSingleStation ? 'border-r border-r-gray-800' : ''} flex-shrink-0 min-h-[1.75rem]`}
          >
            <div className="flex items-center gap-2">
              <Compass className="w-4 h-4 text-gray-400" />
              {!isDiff && (
                <span className="text-sm text-gray-400">Direction</span>
              )}
            </div>
            <div className="text-lg font-semibold text-white">
              {windDirection !== undefined
                ? getWindDirectionLabel(windDirection)
                : '--'}
            </div>
          </div>

          {/* Solar Radiation - Always render for alignment */}
          <MetricRow
            icon={<Zap className="w-4 h-4 text-yellow-300" />}
            label="Solar"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            weight="semibold"
            neutralClassName="text-white"
            undefinedClassName="text-gray-500"
            value={weatherData?.solarRadiation}
            unit=" W/m²"
            decimals={0}
          />

          {/* Illuminance - Always render for alignment */}
          <MetricRow
            icon={<Sun className="w-4 h-4 text-gray-500" />}
            label="Light"
            isDiff={isDiff}
            isSingleStation={isSingleStation}
            weight="semibold"
            labelClassName="text-gray-500"
            neutralClassName="text-gray-300"
            undefinedClassName="text-gray-500"
            value={weatherData?.illuminance}
            unit=" lux"
            decimals={0}
          />
        </div>
      </div>
    </div>
  );
}
