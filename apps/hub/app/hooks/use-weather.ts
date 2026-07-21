import { useCallback, useEffect, useState } from 'react';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import type { WeatherSnapshot } from '~/lib/weatherflow/types';

/**
 * Fetch the server's weather snapshot on mount and every POLL_INTERVAL.
 * A failed fetch keeps the last snapshot; the UI derives staleness from
 * observation age rather than tracking connection state.
 */
export function useWeather() {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/weather');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSnapshot(await res.json());
      setFetchError(null);
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
