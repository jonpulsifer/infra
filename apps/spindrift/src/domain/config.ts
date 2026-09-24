/**
 * Config rules shared by the commands that set, replace and place config. Core
 * never reads a value back, so a move between stores demands the keys again.
 */
import type { ConfigScope, SecretVersion } from '../adapters/store/contract.ts';
import type { StoreAdapter, TargetAdapter } from '../config/manifest.schema.ts';
import { targetLabel } from './target.ts';

/**
 * The rollback depth: a Deploy pins the versions it delivered, so the
 * tenth-newest is the oldest a rollback can still come up configured from.
 */
export const CONFIG_RETENTION = 10;

/**
 * Valid both as a process environment name and as a Kubernetes Secret key.
 * Checked at the command, so a bad name never reaches apply.
 */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The one place a Target is spelled for a store scope. The store's item name
 * derives from it, so a second spelling would split one scope's items.
 */
export function configScopeOf(names: {
  app: string;
  component: string;
  vessel: string;
  adapter: TargetAdapter;
}): ConfigScope {
  return {
    app: names.app,
    component: names.component,
    target: targetLabel(names),
  };
}

/**
 * The installation's preferred store wins where the Target reaches and can write
 * it. Null means the Target cannot hold config.
 */
export function storeOfRecordFor(
  reachable: readonly StoreAdapter[],
  writable: (adapter: StoreAdapter) => boolean,
  preferred: StoreAdapter,
): StoreAdapter | null {
  if (reachable.includes(preferred) && writable(preferred)) return preferred;
  return reachable.find((adapter) => writable(adapter)) ?? null;
}

/** With a shared store only the reference moves. Otherwise nothing can, since core holds no value. */
export function sharesStoreOfRecord(
  from: StoreAdapter | null,
  to: StoreAdapter | null,
): boolean {
  return from !== null && from === to;
}

/**
 * Sorted, because a developer reads the list and a command compares against it.
 * Keys already configured at the destination are not demanded.
 */
export function keysThatWillNotFollow(input: {
  readonly configured: readonly string[];
  readonly alreadyAtDestination: readonly string[];
  readonly sharesStore: boolean;
}): string[] {
  if (input.sharesStore) return [];
  const present = new Set(input.alreadyAtDestination);
  return [...new Set(input.configured)]
    .filter((key) => !present.has(key))
    .sort();
}

/**
 * The versions past the retention depth. The store lists newest first and only
 * the adapter knows the order, so nothing is re-sorted here.
 */
export function reapable(
  versions: readonly SecretVersion[],
  retention: number = CONFIG_RETENTION,
): SecretVersion[] {
  return versions.slice(retention);
}
