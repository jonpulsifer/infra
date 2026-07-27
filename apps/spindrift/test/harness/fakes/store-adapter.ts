/**
 * A fake secret store (Task 7).
 *
 * § Testing: **"Fake the far side, not our side."** This is the vault that is
 * not there. It is constructible under either pinning strategy, because §10
 * claims the reference `put` returns has the same shape either way and nothing
 * above the seam can tell which produced it — a claim the conformance suite can
 * only falsify if both are runnable.
 *
 * Values written are held so `put`/`describe` round-trips can be asserted, but
 * they are never returned across the contract: §10's read-back is metadata, and
 * the value crosses in one direction only.
 */
import type {
  ConfigScope,
  PinningStrategy,
  SecretReference,
  SecretStore,
  SecretVersion,
} from '../../../src/adapters/store/contract.ts';
import type { StoreAdapter } from '../../../src/config/manifest.schema.ts';

interface StoredVersion {
  version: SecretVersion;
  /** Held only so a test can prove what was written; never handed back. */
  value: string;
}

export interface FakeSecretStoreOptions {
  adapter?: StoreAdapter;
  pinning?: PinningStrategy;
}

/** The store's own name for a scoped key — the adapter's business, per §10. */
function itemName(scope: ConfigScope, key: string): string {
  return `${scope.app}/${scope.component}/${scope.target}/${key}`;
}

export class FakeSecretStore implements SecretStore {
  readonly adapter: StoreAdapter;
  readonly pinning: PinningStrategy;

  /** Every `put`, in call order. */
  readonly puts: { scope: ConfigScope; key: string }[] = [];
  /** Every `destroy`, including the repeats that prove idempotence. */
  readonly destroyed: SecretReference[] = [];

  /** Keyed by the reference's own identity, so a lookup is what a read is. */
  private readonly stored = new Map<string, StoredVersion>();
  private counter = 0;

  constructor(options: FakeSecretStoreOptions = {}) {
    this.adapter = options.adapter ?? 'gcp-secret-manager';
    this.pinning = options.pinning ?? 'NATIVE';
  }

  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    this.puts.push({ scope, key });
    this.counter += 1;
    const sequence = String(this.counter);
    const item = itemName(scope, key);

    // The two strategies differ in where the version lives, and in nothing
    // else a caller can observe: NATIVE addresses a version of one item, and
    // IMMUTABLE_ITEM_PER_VERSION mints a fresh item and reports it as one.
    const reference: SecretReference =
      this.pinning === 'NATIVE'
        ? { key: item, version: sequence }
        : { key: `${item}@${sequence}`, version: sequence };

    this.stored.set(referenceId(reference), {
      value,
      version: { reference, key, createdAt: new Date(this.counter) },
    });
    return reference;
  }

  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    return this.stored.get(referenceId(reference))?.version ?? null;
  }

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const item = itemName(scope, key);
    return [...this.stored.values()]
      .filter(({ version }) => version.reference.key.split('@')[0] === item)
      .map(({ version }) => version)
      .sort(
        (a, b) => Number(b.reference.version) - Number(a.reference.version),
      );
  }

  async destroy(reference: SecretReference): Promise<void> {
    this.destroyed.push(reference);
    this.stored.delete(referenceId(reference));
  }

  /** What was written, for a test to assert against. Never a contract verb. */
  written(reference: SecretReference): string | null {
    return this.stored.get(referenceId(reference))?.value ?? null;
  }
}

function referenceId(reference: SecretReference): string {
  return `${reference.key}#${reference.version}`;
}
