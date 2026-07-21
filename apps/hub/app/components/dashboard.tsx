import { AlertCircle, Clock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useWeather } from '~/hooks/use-weather';
import { diffStations } from '~/lib/weatherflow/diff';
import { RefreshMenu } from './RefreshMenu';
import { StationDisplay } from './StationDisplay';

export default function Dashboard() {
  const { snapshot, fetchError, refresh } = useWeather();
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

  return (
    <div className="h-screen w-full flex flex-col bg-gray-900">
      {/* Header */}
      <div className="flex justify-between items-center px-2 py-1 border-b border-gray-700 flex-shrink-0 relative">
        <div className="flex items-center gap-2">
          <Clock className="w-4 h-4 text-gray-400" />
          <div className="text-xs font-medium text-gray-400">
            {currentTime ? formatDate(currentTime) : '---, --- --'}
          </div>
        </div>
        <div className="absolute -translate-x-1/2 left-1/2">
          <div className="text-3xl font-black text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-pink-400 tabular-nums tracking-wider">
            {currentTime ? formatTime(currentTime) : '--:--:--'}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {(error || fetchError) && (
            <div className="flex items-center gap-1 px-2 py-1 bg-red-900/50 rounded">
              <AlertCircle className="w-4 h-4 text-red-400" />
              <span className="text-sm text-red-400 font-semibold">Error</span>
            </div>
          )}
          <RefreshMenu onRefresh={handleRefresh} isRefreshing={isRefreshing} />
        </div>
      </div>

      {/* Three Column Layout: Left Station | Difference | Right Station */}
      <div className="flex-1 flex overflow-hidden w-full">
        {stations.length > 0 && now != null ? (
          <>
            {stations[0] && (
              <StationDisplay
                key={stations[0].stationId}
                label={stations[0].name}
                observation={stations[0].observation}
                now={now}
              />
            )}

            {/* Difference column - only with exactly 2 stations */}
            {stations.length === 2 && (
              <StationDisplay
                key="diff"
                label="Difference"
                observation={diffStations(
                  stations[0].observation ?? {},
                  stations[1].observation ?? {},
                )}
                isDiff
                now={now}
              />
            )}

            {stations.slice(1).map((station) => (
              <StationDisplay
                key={station.stationId}
                label={station.name}
                observation={station.observation}
                now={now}
              />
            ))}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-gray-500 gap-4">
            {error ? (
              <>
                <AlertCircle className="w-16 h-16 text-red-400" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-red-400">
                    {snapshot?.configError
                      ? 'Configuration Error'
                      : 'Connection Error'}
                  </div>
                  <div className="text-base text-gray-400 mt-2 whitespace-pre-line">
                    {error}
                  </div>
                </div>
              </>
            ) : !snapshot ? (
              <>
                <div className="w-16 h-16 border-4 border-blue-400/30 border-t-blue-400 rounded-full animate-spin" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-blue-400">
                    Loading...
                  </div>
                  <div className="text-base text-gray-500 mt-2">
                    Fetching weather data
                  </div>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="w-16 h-16 text-gray-600" />
                <div className="text-center">
                  <div className="text-2xl font-semibold text-gray-500">
                    No Stations Available
                  </div>
                  <div className="text-base text-gray-600 mt-2">
                    Waiting for weather stations to report in...
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
