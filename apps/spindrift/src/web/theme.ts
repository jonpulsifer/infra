/**
 * Theme selection, dark by default. `system` removes `data-theme` so the
 * stylesheet's `prefers-color-scheme` keeps following the OS.
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
  return isTheme(stored) ? stored : 'dark';
}

/** A server render has no `localStorage`. */
function readOnServer(): Theme {
  return 'dark';
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
