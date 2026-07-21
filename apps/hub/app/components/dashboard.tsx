import { AlertCircle, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWeather } from '~/hooks/use-weather';
import { computeLeaders } from '~/lib/weatherflow/leader';
import { DevControls } from './DevControls';
import { RefreshMenu } from './RefreshMenu';
import { StationDisplay } from './StationDisplay';

export default function Dashboard() {
  const { snapshot, fetchError, refresh, dev } = useWeather();
  const [now, setNow] = useState<number | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Tick every second: drives the clock and the per-station freshness text
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const formatTime = (date: Date) =>
    date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const formatDate = (date: Date) =>
    date.toLocaleDateString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

  const stations = snapshot?.stations ?? [];
  const error = snapshot?.configError ?? (snapshot ? null : fetchError);
  const currentTime = now != null ? new Date(now) : null;
  const leaders = computeLeaders(stations.map((s) => s.observation));
  const solo = stations.length === 1;

  const temps = stations
    .map((s) => s.observation?.temperature)
    .filter((t): t is number => t != null);
  const warmest = temps.length ? Math.max(...temps) : null;
  const spread = temps.length > 1 ? warmest! - Math.min(...temps) : null;

  return (
    <div className="h-screen w-full flex flex-col bg-[#0b0f15]">
      {/* Header */}
      <header className="flex justify-between items-center px-4 py-1.5 border-b border-white/[0.07] flex-shrink-0 relative">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-slate-500" />
          <div className="text-[0.66rem] uppercase tracking-wider font-semibold text-slate-400">
            {currentTime ? formatDate(currentTime) : '---, --- --'}
          </div>
        </div>
        <div className="absolute -translate-x-1/2 left-1/2">
          <div className="text-[1.65rem] font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 tabular-nums tracking-wider">
            {currentTime ? formatTime(currentTime) : '--:--:--'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {spread != null && (
            <span className="text-[0.64rem] uppercase tracking-wide font-bold text-slate-500 tabular-nums">
              {spread.toFixed(1)}° spread
            </span>
          )}
          {(error || fetchError) && (
            <div className="flex items-center gap-1 px-2 py-0.5 bg-red-900/50 rounded">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-xs text-red-400 font-semibold">Error</span>
            </div>
          )}
          <RefreshMenu onRefresh={handleRefresh} isRefreshing={isRefreshing} />
        </div>
      </header>

      {/* Station panels */}
      <main className="flex-1 min-h-0 overflow-auto">
        {stations.length > 0 && now != null ? (
          <div className="min-h-full flex flex-col sm:flex-row gap-px bg-white/[0.07]">
            {stations.map((station, index) => {
              const temp = station.observation?.temperature;
              const other =
                stations.length === 2
                  ? stations[index === 0 ? 1 : 0].observation?.temperature
                  : undefined;
              return (
                <StationDisplay
                  key={station.stationId}
                  label={station.name}
                  observation={station.observation}
                  now={now}
                  index={index}
                  leaders={leaders}
                  isWarmest={
                    stations.length > 1 && temp != null && temp === warmest
                  }
                  tempDelta={
                    temp != null && other != null ? temp - other : null
                  }
                  solo={solo}
                  onRemove={
                    dev.enabled
                      ? () => dev.removeStation(station.stationId)
                      : undefined
                  }
                />
              );
            })}
          </div>
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-slate-500 gap-4">
            {error ? (
              <>
                <AlertCircle className="w-16 h-16 text-red-400" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-red-400">
                    {snapshot?.configError
                      ? 'Configuration Error'
                      : 'Connection Error'}
                  </div>
                  <div className="text-base text-slate-400 mt-2 whitespace-pre-line">
                    {error}
                  </div>
                </div>
              </>
            ) : !snapshot ? (
              <>
                <div className="w-16 h-16 border-4 border-sky-400/30 border-t-sky-400 rounded-full animate-spin" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-sky-400">
                    Loading...
                  </div>
                  <div className="text-base text-slate-500 mt-2">
                    Fetching weather data
                  </div>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-16 h-16 text-slate-600" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-slate-500">
                    No Stations Available
                  </div>
                  <div className="text-base text-slate-600 mt-2">
                    Waiting for weather stations to report in...
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </main>

      {dev.enabled && (
        <DevControls
          count={stations.length}
          onAdd={dev.addStation}
          onRemove={() => dev.removeStation()}
        />
      )}
    </div>
  );
}
