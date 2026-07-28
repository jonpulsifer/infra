/**
 * Config as a lifecycle, not a table (§10).
 *
 * The table is `config_items`; this is everything about it that is a rule rather
 * than a column, kept out of the commands so the three that touch config —
 * set, replace, and place — cannot disagree about any of it.
 *
 * The two rules with teeth:
 *
 * - **Core never retrieves, therefore core cannot migrate.** §10 accepts that
 *   consequence rather than relaxing write-only for migration, "because the
 *   carve-out *is* the boundary". What replaces migration is
 *   {@link keysThatWillNotFollow}: Place names the keys that will not follow a
 *   move and demands them before it commits, so a re-placement never comes up
 *   green and unconfigured.
 * - **Retention is core's responsibility, at N = 10.** "No store offers a
 *   delegate-to-the-registry escape... the same depth as artifacts: a
 *   constraint, not a coincidence, since shallower config makes a rollback come
 *   up green and unconfigured." {@link reapable} is what a loop hands to
 *   `destroy`.
 */
import type { ConfigScope, SecretVersion } from '../adapters/store/contract.ts';
import type { StoreAdapter } from '../config/manifest.schema.ts';

/**
 * §10: "Retention N = 10, the same depth as artifacts."
 *
 * It is the depth a rollback can reach, not a storage budget: a Deploy pins the
 * versions it delivered, so the tenth-newest version is the oldest one a
 * rollback can still come up configured from.
 */
export const CONFIG_RETENTION = 10;

/**
 * What a variable may be called.
 *
 * The intersection of what a process environment accepts and what a Kubernetes
 * Secret key accepts, which is what every delivery path here goes through. A
 * name outside it is refused at the command rather than at apply, where the
 * developer who typed it is gone.
 */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The store scope a (App, Component, Target) triple names (§10). */
export function configScopeOf(names: {
  app: string;
  component: string;
  target: string;
}): ConfigScope {
  return {
    app: names.app,
    component: names.component,
    target: names.target,
  };
}

/**
 * Which store one Target's config lives in (§10).
 *
 * §10 makes the store a Target property — "Kubernetes Targets carry an
 * admin-chosen store; the cloud Targets take the cloud store in the App's
 * vessel, not a choice" — so it is chosen from what *this* Target reaches,
 * narrowed to what the installation has an access path to. A Target that
 * reaches only stores core cannot write to has no store of record, and cannot
 * hold config at all.
 *
 * The installation's own store wins where a Target reaches it, so that the
 * common case — every Target in front of one vault — puts every Component's
 * config in the same place and makes re-placement free.
 */
export function storeOfRecordFor(
  reachable: readonly StoreAdapter[],
  writable: (adapter: StoreAdapter) => boolean,
  preferred: StoreAdapter,
): StoreAdapter | null {
  if (reachable.includes(preferred) && writable(preferred)) return preferred;
  return reachable.find((adapter) => writable(adapter)) ?? null;
}

/**
 * Whether config written for one Target can be delivered on another.
 *
 * §10: "**a store is its store of record plus one or more access paths.** Both
 * clusters run their own connect service in front of the same vault, which is
 * why cluster-to-cluster re-placement is free." Free means exactly this: the
 * item is the same item, so the *reference* moves and no value has to.
 *
 * When the two Targets do not share a store of record, nothing moves — core
 * holds no value it could carry across, and the reference names an item the
 * destination cannot reach.
 */
export function sharesStoreOfRecord(
  from: StoreAdapter | null,
  to: StoreAdapter | null,
): boolean {
  return from !== null && from === to;
}

/**
 * The keys a move to another Target will not carry with it (§10).
 *
 * Sorted, because this list is a sentence a developer reads and a set a command
 * compares what they supplied against — both want a stable order.
 *
 * Already-configured keys at the destination are not demanded: a key that has a
 * value there is a key that follows nothing because it does not need to.
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
 * The versions of one key that are past the retention depth (§10).
 *
 * Takes the store's own list — newest first, as the contract's `versions`
 * promises — and returns the tail beyond {@link CONFIG_RETENTION}. Order is not
 * re-derived here: a store that pins by minting an immutable item per version
 * has no version *number* to sort by, and the adapter is the only thing that
 * knows which of its items is newer.
 */
export function reapable(
  versions: readonly SecretVersion[],
  retention: number = CONFIG_RETENTION,
): SecretVersion[] {
  return versions.slice(retention);
}
