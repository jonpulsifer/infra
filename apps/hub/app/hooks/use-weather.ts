import { useCallback, useEffect, useState } from 'react';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import type { WeatherSnapshot } from '~/lib/weatherflow/types';

/**
 * Fetch the server's weather snapshot on mount and every POLL_INTERVAL.
 * A failed fetch keeps the last snapshot; the UI derives staleness from
 * observation age rather than tracking connection state.
 */
const RELOAD_AT_KEY = 'hub-last-auto-reload';

/**
 * A snapshot from a newer server build means this page's bundle is outdated
 * (the kiosk browser never navigates on its own). Reload to pick it up, at
 * most once every 5 minutes so a rolling deploy serving mixed versions can't
 * put the display in a reload loop.
 */
function reloadIfNewBuild(serverBuildId: string) {
  if (!serverBuildId || serverBuildId === __BUILD_ID__) return;
  const lastReload = Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? '0');
  if (Date.now() - lastReload < 5 * 60_000) return;
  sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  window.location.reload();
}

export function useWeather() {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: WeatherSnapshot = await res.json();
      setSnapshot(data);
      setFetchError(null);
      reloadIfNewBuild(data.buildId);
    } catch (error) {
      setFetchError(
        error instanceof Error ? error.message : 'Failed to fetch weather data',
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, WEATHERFLOW_CONFIG.POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [refresh]);

  return { snapshot, fetchError, refresh };
}
