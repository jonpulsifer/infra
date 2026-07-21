import { useCallback, useEffect, useRef, useState } from 'react';
import { WEATHERFLOW_CONFIG } from '~/lib/weatherflow/config';
import { mockSnapshot } from '~/lib/weatherflow/mock';
import type { WeatherSnapshot } from '~/lib/weatherflow/types';

/**
 * Fetch the server's weather snapshot on mount and every POLL_INTERVAL.
 * A failed fetch keeps the last snapshot; the UI derives staleness from
 * observation age rather than tracking connection state.
 *
 * In development (`import.meta.env.DEV`) the network is bypassed entirely: a
 * synthetic snapshot is generated locally so the display can be exercised
 * without a live TempestWx token, and the returned `dev` controls let you add
 * and remove mock stations on the fly. The whole mock path is a compile-time
 * constant branch, so it's tree-shaken out of production builds.
 */
const RELOAD_AT_KEY = 'hub-last-auto-reload';

// Vite compile-time constant — the mock branches below dead-code away in prod.
const IS_DEV = import.meta.env.DEV;

// Faster tick in dev so the smooth value drift (and the leaders shifting) is
// visible while iterating; prod keeps the real cadence.
const DEV_POLL_INTERVAL = 2_000;

export interface DevControls {
  /** True only in a dev build; false (and the callbacks are no-ops) in prod. */
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

export function useWeather(): UseWeatherResult {
  const [snapshot, setSnapshot] = useState<WeatherSnapshot | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Dev-only mock station list. The ref is the source of truth so the poll
  // interval and the add/remove callbacks always see the current seeds without
  // stale closures; snapshot state is what actually drives re-renders.
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
