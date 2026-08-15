/**
 * The secret store contract (§10).
 *
 * One store per Target, **per-key, pinned, and delivered by the platform's own
 * secret operator**. Spindrift writes; the operator on the far side reads. That
 * shape is what the three rules below defend:
 *
 * - **Values are write-only.** Runtime config has no verb here that returns a
 *   value. Plaintext is confined to transient request memory and the store,
 *   auditing is metadata only, and redaction is structural rather than a promise
 *   to scrub what an App prints (§10). The consequence is stated and accepted:
 *   core cannot migrate config between stores, so Place names the keys that will
 *   not follow and demands them before the move commits. {@link SecretStore.open}
 *   is the one stated exception, and it belongs to build dispatch alone.
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
 * - `CURRENT_ONLY` — the store holds exactly one value per name and there is no
 *   Spindrift-side name that would let a second one exist, because the name
 *   *is* what the workload reads. A put still mints a new reference, so a
 *   config change still produces a new Deploy; what does not survive is the
 *   version it superseded.
 *
 * **The third one costs something the other two do not, and it is stated here
 * rather than hidden in an adapter.** §10 pins a version so "a rollback comes
 * back up with the configuration it originally had" — under `CURRENT_ONLY` a
 * rollback past a config change cannot do that, because the document it is
 * pinned to no longer resolves. It is therefore **refused** rather than
 * deployed bare: `placeIntent` describes every pinned reference before writing
 * an intent, and a store of this strategy is exactly the case that check exists
 * for. Retention (§10's N = 10) is a no-op here — there is never more than one
 * version to reap.
 *
 * A property of the far side, never a preference. A store gets this strategy
 * because its API cannot express a second version of a live name, which is true
 * of an edge platform whose environment variables *are* the runtime's own
 * namespace.
 */
export type PinningStrategy =
  | 'NATIVE'
  | 'IMMUTABLE_ITEM_PER_VERSION'
  | 'CURRENT_ONLY';

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
   * The value of one pinned version, or `null` when it is gone.
   *
   * The one narrow exception to "values are write-only", and it exists for
   * exactly one caller: `dispatchBuild` resolving a Component's *build*
   * secrets. A runtime secret is delivered by the platform's own operator and
   * core never needs the value; a build secret has no operator on the far side
   * — the builder is handed the resolved value for the length of one dispatch,
   * so that no builder ever holds a credential *to the store* (§4). Nothing
   * else may call this, and no command returns what it opens.
   *
   * Optional because not every store can answer: a `CURRENT_ONLY` edge store's
   * items are the runtime's own namespace, with no read API worth trusting. A
   * store without this verb cannot back a build secret, and dispatch refuses
   * the build with a sentence rather than running it without.
   */
  open?(reference: SecretReference): Promise<string | null>;

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
