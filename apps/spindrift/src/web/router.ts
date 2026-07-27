/**
 * Navigation, hand-rolled — because no framework means owning it (plan Risk 5).
 *
 * The whole router is the hash. That is a smaller choice than it looks:
 * `Bun.serve`'s route table serves **one** HTML entry, the dispatch endpoint,
 * and the two WebSockets, and nothing else. There is no server-side routing per
 * screen, so a History-API router would need every unknown path to fall through
 * to the same document — a server rule that exists only to support the client,
 * and the first hand-authored route on a surface the plan wants to stay
 * generated (Task 36b).
 *
 * `useSyncExternalStore` rather than an effect: the hash is external state that
 * can change between render and commit — a link clicked during a transition is
 * the ordinary case — and this is the hook that exists to read such a thing
 * without tearing.
 */
import { useCallback, useSyncExternalStore } from 'react';

function subscribe(onChange: () => void): () => void {
  addEventListener('hashchange', onChange);
  return () => removeEventListener('hashchange', onChange);
}

/** The path part of the hash, always leading-slashed, never empty. */
function currentPath(): string {
  const raw = location.hash.replace(/^#/, '');
  return raw.startsWith('/') ? raw : `/${raw}`;
}

/** The server render has no `location`; the entry route is the honest answer. */
function serverPath(): string {
  return '/';
}

export interface Route {
  /** The path, e.g. `/apps/new`. */
  readonly path: string;
  /** Path segments, already split and empty-stripped. */
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
