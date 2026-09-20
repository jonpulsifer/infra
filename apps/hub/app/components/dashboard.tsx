import { AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWeather } from '~/hooks/use-weather';
import { clockTime } from '~/lib/format-time';
import { stationAccent } from '~/lib/station-accent';
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

  const stations = snapshot?.stations ?? [];
  const error = snapshot?.configError ?? (snapshot ? null : fetchError);
  const currentTime = now != null ? new Date(now) : null;
  const leaders = computeLeaders(stations.map((s) => s.observation));

  const temps = stations
    .map((s) => s.observation?.temperature)
    .filter((t): t is number => t != null);
  const spread =
    temps.length > 1 ? Math.max(...temps) - Math.min(...temps) : null;

  return (
    <div className="flex h-dvh w-full flex-col bg-[#0b0f15]">
      <header className="relative flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.07] px-4 pb-1.5 pt-[max(0.375rem,env(safe-area-inset-top))]">
        <div className="text-[0.66rem] font-semibold uppercase tracking-wider text-slate-400">
          <span className="sm:hidden">
            {currentTime
              ? currentTime.toLocaleDateString([], {
                  month: 'short',
                  day: 'numeric',
                })
              : '--- --'}
          </span>
          <span className="hidden sm:inline">
            {currentTime
              ? currentTime.toLocaleDateString([], {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })
              : '---, --- --'}
          </span>
        </div>

        <div className="absolute left-1/2 -translate-x-1/2 text-[1.4rem] font-bold tracking-[0.04em] tabular-nums text-slate-100 sm:text-[1.7rem]">
          {currentTime ? clockTime(currentTime) : '--:--'}
        </div>

        <div className="flex items-center gap-3">
          {spread != null && (
            <span className="hidden items-baseline gap-1.5 text-[0.64rem] font-bold uppercase tracking-wide text-slate-500 sm:inline-flex">
              Spread
              <span className="tabular-nums text-slate-300">
                {spread.toFixed(1)}°
              </span>
            </span>
          )}
          {(error || fetchError) && (
            <div className="flex items-center gap-1 rounded bg-red-900/50 px-2 py-0.5">
              <AlertCircle className="h-4 w-4 text-red-400" />
              <span className="text-xs font-semibold text-red-400">Error</span>
            </div>
          )}
          <RefreshMenu onRefresh={handleRefresh} isRefreshing={isRefreshing} />
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)] sm:overflow-hidden sm:pb-0">
        {stations.length > 0 && now != null ? (
          <div className="flex min-h-full flex-col gap-px bg-white/[0.07] sm:h-full sm:min-h-0 sm:flex-row">
            {stations.map((station, index) => {
              const temp = station.observation?.temperature;
              const other = stations.length === 2 ? stations[1 - index] : null;
              const otherTemp = other?.observation?.temperature;
              return (
                <StationDisplay
                  key={station.stationId}
                  label={station.name}
                  observation={station.observation}
                  history={station.history}
                  now={now}
                  index={index}
                  accent={stationAccent(index)}
                  leaders={leaders}
                  tempDelta={
                    temp != null && otherTemp != null ? temp - otherTemp : null
                  }
                  otherName={other?.name}
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
          <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-slate-500">
            {error ? (
              <>
                <AlertCircle className="h-16 w-16 text-red-400" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-red-400">
                    {snapshot?.configError
                      ? 'Configuration Error'
                      : 'Connection Error'}
                  </div>
                  <div className="mt-2 whitespace-pre-line text-base text-slate-400">
                    {error}
                  </div>
                </div>
              </>
            ) : !snapshot ? (
              <>
                <div className="h-16 w-16 animate-spin rounded-full border-4 border-sky-400/30 border-t-sky-400" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-sky-400">
                    Loading...
                  </div>
                  <div className="mt-2 text-base text-slate-500">
                    Fetching weather data
                  </div>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="h-16 w-16 text-slate-600" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-slate-500">
                    No Stations Available
                  </div>
                  <div className="mt-2 text-base text-slate-600">
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
