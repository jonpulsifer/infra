/**
 * The secret store contract: one secret per variable, pinned by version. Core
 * writes, the platform's secret operator delivers, and only
 * {@link SecretStore.open} reads a value back.
 */
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import type { SecretReference } from '../../domain/desired-state.ts';

/**
 * A config item's (Component, Target) scope. The App is carried because
 * deleting an App deletes its config items.
 */
export interface ConfigScope {
  app: string;
  component: string;
  target: string;
}

/**
 * How a store pins. Under `CURRENT_ONLY` a put replaces the only version, so a
 * rollback past a config change is refused, not deployed without its config.
 */
export type PinningStrategy =
  | 'NATIVE'
  | 'IMMUTABLE_ITEM_PER_VERSION'
  | 'CURRENT_ONLY';

/** Metadata about one pinned version. Never the value. */
export interface SecretVersion {
  reference: SecretReference;
  key: string;
  createdAt: Date;
}

/** One store of record, reached over one access path. */
export interface SecretStore {
  readonly adapter: StoreAdapter;
  readonly pinning: PinningStrategy;

  /** Always writes a new version, and returns the reference a Deploy pins. */
  put(scope: ConfigScope, key: string, value: string): Promise<SecretReference>;

  /** `null` when the version is gone; core checks this before deploying on it. */
  describe(reference: SecretReference): Promise<SecretVersion | null>;

  /**
   * The value, or `null` when gone. Only build dispatch may call this, and no
   * command returns it. A store without it cannot hold build secrets.
   */
  open?(reference: SecretReference): Promise<string | null>;

  /** Every version written for one key, newest first. Core reaps from this. */
  versions(scope: ConfigScope, key: string): Promise<SecretVersion[]>;

  /** Idempotent: destroying a version that is already gone succeeds. */
  destroy(reference: SecretReference): Promise<void>;
}

export type { SecretReference } from '../../domain/desired-state.ts';
