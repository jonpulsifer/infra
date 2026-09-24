/**
 * Hash navigation. The server has one HTML entry and no per-screen routes, and
 * `useSyncExternalStore` reads the hash without tearing.
 */
import { useCallback, useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  addEventListener('hashchange', onChange);
  return () => removeEventListener('hashchange', onChange);
}

/** Always starts with a slash. */
function currentPath(): string {
  const raw = location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** A server render has no `location`. */
function serverPath(): string {
  return '/';
}

export interface Route {
  readonly path: string;
  readonly segments: readonly string[];
  navigate(path: string): void;
}

export function useRoute(): Route {
  const path = useSyncExternalStore(subscribe, currentPath, serverPath);

  const navigate = useCallback((next: string) => {
    location.hash = next;
  }, []);

  return {
    path,
    segments: path.split('/').filter(Boolean),
    navigate,
  };
}
