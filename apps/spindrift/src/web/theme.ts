/**
 * Theme selection: OS preference by default, an explicit choice when made.
 *
 * The stylesheet already answers `prefers-color-scheme`, so `system` is not a
 * third theme — it is the absence of the attribute, which is why choosing it
 * removes `data-theme` rather than computing a value and writing it back.
 * Computing it would freeze the page at whatever the OS said at load, and the
 * OS is allowed to change its mind at sunset.
 */
import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'spindrift.theme';

const listeners = new Set<() => void>();

function isTheme(value: string | null): value is Theme {
  return value === 'system' || value === 'light' || value === 'dark';
}

function read(): Theme {
  const stored = localStorage.getItem(KEY);
  return isTheme(stored) ? stored : 'system';
}

/** The server render has no `localStorage`, and no reader to have a preference. */
function readOnServer(): Theme {
  return 'system';
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function applyTheme(theme: Theme): void {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

/** Called once at boot, before first paint, so the page never flashes. */
export function restoreTheme(): void {
  applyTheme(read());
}

export function useTheme(): [Theme, (theme: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, read, readOnServer);

  const set = useCallback((next: Theme) => {
    localStorage.setItem(KEY, next);
    applyTheme(next);
    for (const listener of listeners) listener();
  }, []);

  return [theme, set];
}
