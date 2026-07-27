/**
 * The secret store contract (§10).
 *
 * One store per Target, **per-key, pinned, and delivered by the platform's own
 * secret operator**. Spindrift writes; the operator on the far side reads. That
 * shape is what the three rules below defend:
 *
 * - **Values are write-only.** There is deliberately no verb here that returns a
 *   value. Plaintext is confined to transient request memory and the store,
 *   auditing is metadata only, and redaction is structural rather than a promise
 *   to scrub what an App prints (§10). The consequence is stated and accepted:
 *   core cannot migrate config between stores, so Place names the keys that will
 *   not follow and demands them before the move commits.
 * - **One secret per variable, not a blob.** The blob is elegant on Kubernetes
 *   and has no cloud-runtime equivalent, so the contract is per key (§10).
 * - **Pinned, never a floating latest.** A put returns the reference to the
 *   version it just wrote, and that reference is what a Deploy carries.
 *   `configVersion` is a hash over a document of those references, scoped to
 *   (Component, Target) — so a config change produces a new Deploy rather than
 *   silently not applying on Kubernetes (§10).
 */
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import type { SecretReference } from '../../domain/desired-state.ts';

/**
 * Which (Component, Target) pair a config item belongs to — the scope
 * `configVersion` is defined over (§10). The App is carried too because
 * deleting an App deletes its own config items (§2).
 *
 * The scope is Spindrift's, not the store's: how it becomes an item name is the
 * adapter's business, which is what lets one vault back several Targets.
 */
export interface ConfigScope {
  app: string;
  component: string;
  target: string;
}

/**
 * How a store pins.
 *
 * - `NATIVE` — the store versions items itself and a version is addressable.
 * - `IMMUTABLE_ITEM_PER_VERSION` — it does not, so the adapter writes a fresh
 *   immutable item per version under a Spindrift-side name and reports it as a
 *   version. §10 records this as making the contract *more* portable, not less:
 *   the reference {@link SecretStore.put} returns has the same shape either way,
 *   and nothing above this seam can tell which strategy produced it.
 */
export type PinningStrategy = 'NATIVE' | 'IMMUTABLE_ITEM_PER_VERSION';

/** Metadata about one pinned version. Never the value (§10). */
export interface SecretVersion {
  reference: SecretReference;
  /** The variable this version fills, as {@link SecretStore.put} was given it. */
  key: string;
  createdAt: Date;
}

/**
 * One store of record, reached over one access path.
 *
 * §10: a store is its store of record plus one or more access paths, which is
 * why two clusters running their own connect service in front of the same vault
 * are one store and cluster-to-cluster re-placement is free. The reach rule
 * binds the store to **the Target the Component is placed on**, not to every
 * Target — reachability is a Target capability (§3), so it is not asked here.
 */
export interface SecretStore {
  /** Which store adapter this is, in the vocabulary the manifest seeds. */
  readonly adapter: StoreAdapter;
  /** Declared so the conformance suite can assert both strategies pin. */
  readonly pinning: PinningStrategy;

  /**
   * Write a value and return the pinned reference to the version just written.
   *
   * The value is the only plaintext that crosses this seam, and it crosses in
   * one direction. Uploads are replace-with-diff above this verb (§10): a put is
   * always a new version, never an edit of one.
   */
  put(scope: ConfigScope, key: string, value: string): Promise<SecretReference>;

  /**
   * Metadata for a pinned reference, or `null` when it is gone.
   *
   * This is the read-back: what a store round-trips is the reference, never the
   * value. Core uses it to prove a Deploy's pinned document still resolves
   * before it deploys against it.
   */
  describe(reference: SecretReference): Promise<SecretVersion | null>;

  /**
   * Every version Spindrift has written for one key, newest first.
   *
   * Config lifecycle is a core responsibility — no store offers an escape to
   * delegate it — and retention is N = 10, the same depth as artifacts, since
   * shallower config makes a rollback come up green and unconfigured. Core reaps
   * on a loop, and this is what it reaps from (§10).
   */
  versions(scope: ConfigScope, key: string): Promise<SecretVersion[]>;

  /** Idempotent: destroying a version that is already gone succeeds. */
  destroy(reference: SecretReference): Promise<void>;
}

export type { SecretReference } from '../../domain/desired-state.ts';
