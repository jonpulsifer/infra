import { useCallback, useEffect, useRef, useState } from 'react';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import { mockSnapshot } from '~/lib/weatherflow/mock';
import type { WeatherSnapshot } from '~/lib/weatherflow/types';

const RELOAD_AT_KEY = 'hub-last-auto-reload';

// A Vite compile-time constant, so production builds drop the mock branches.
const IS_DEV = import.meta.env.DEV;

// Fast enough in dev to watch the mock values drift.
const DEV_POLL_INTERVAL = 2_000;

export interface DevControls {
  /** False in production builds, where the callbacks do nothing. */
  enabled: boolean;
  addStation: () => void;
  /** Remove a specific mock station, or the last one when omitted. */
  removeStation: (stationId?: number) => void;
}

export interface UseWeatherResult {
  snapshot: WeatherSnapshot | null;
  fetchError: string | null;
  refresh: () => Promise<void>;
  dev: DevControls;
}

/**
 * The kiosk never navigates on its own, so a newer server build reloads the page,
 * at most every 5 minutes so a rolling deploy cannot cause a reload loop.
 */
function reloadIfNewBuild(serverBuildId: string) {
  if (!serverBuildId || serverBuildId === __BUILD_ID__) return;
  const lastReload = Number(sessionStorage.getItem(RELOAD_AT_KEY) ?? '0');
  if (Date.now() - lastReload < 5 * 60_000) return;
  sessionStorage.setItem(RELOAD_AT_KEY, String(Date.now()));
  window.location.reload();
}

/**
 * Polls the server's snapshot. A failed fetch keeps the last one, and the UI
 * derives staleness from observation age. Dev builds use a local mock instead.
 */
export function useWeather(): UseWeatherResult {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Mock seeds live in a ref so the poll and the callbacks never read a stale
  // closure; snapshot state drives re-renders.
  const seedsRef = useRef<number[]>([0, 1]);
  const nextSeedRef = useRef(2);

  const refresh = useCallback(async () => {
    if (IS_DEV) {
      setSnapshot(mockSnapshot(seedsRef.current, Date.now()));
      setFetchError(null);
      return;
    }
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
    const interval = IS_DEV
      ? DEV_POLL_INTERVAL
      : WEATHERFLOW_CONFIG.POLL_INTERVAL;
    const timer = setInterval(refresh, interval);
    return () => clearInterval(timer);
  }, [refresh]);

  const addStation = useCallback(() => {
    if (!IS_DEV) return;
    seedsRef.current = [...seedsRef.current, nextSeedRef.current++];
    setSnapshot(mockSnapshot(seedsRef.current, Date.now()));
  }, []);

  const removeStation = useCallback((stationId?: number) => {
    if (!IS_DEV) return;
    seedsRef.current =
      stationId == null
        ? seedsRef.current.slice(0, -1)
        : seedsRef.current.filter((seed) => 90_000 + seed !== stationId);
    setSnapshot(mockSnapshot(seedsRef.current, Date.now()));
  }, []);

  return {
    snapshot,
    fetchError,
    refresh,
    dev: { enabled: IS_DEV, addStation, removeStation },
  };
}
