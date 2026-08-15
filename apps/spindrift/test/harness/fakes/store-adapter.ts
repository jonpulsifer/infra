/**
 * A fake secret store (Task 7).
 *
 * § Testing: **"Fake the far side, not our side."** This is the vault that is
 * not there. It is constructible under either pinning strategy, because §10
 * claims the reference `put` returns has the same shape either way and nothing
 * above the seam can tell which produced it — a claim the conformance suite can
 * only falsify if both are runnable.
 *
 * **Each strategy stands in for the real store that uses it**, and names its
 * references the way that store does:
 *
 * - `NATIVE` stands for `gcp-secret-manager`, so a key is {@link secretIdFor}'s
 *   `--`-joined id in Secret Manager's alphabet, and a version is the number the
 *   far side counted.
 * - `IMMUTABLE_ITEM_PER_VERSION` stands for `onepassword`, so a key is
 *   {@link itemTitleFor}'s `/`-joined title — the same for every version, since
 *   the item id is what moves — and a version is an opaque id Connect minted.
 *
 * The naming functions are imported rather than reimplemented on purpose. A
 * shape invented here would be a third one that neither real store emits, and a
 * reference no store can hold makes every assertion above the seam — a rendered
 * Cloud Run `secretKeyRef`, a `configVersion` hash — agree about something
 * impossible.
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
import { secretIdFor } from '../../../src/adapters/store/gcp-secret-manager.ts';
import { itemTitleFor } from '../../../src/adapters/store/onepassword.ts';
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

/** Which real store each strategy stands for, and how that store names. */
const STANDS_FOR: Record<
  PinningStrategy,
  { adapter: StoreAdapter; name: (scope: ConfigScope, key: string) => string }
> = {
  NATIVE: { adapter: 'gcp-secret-manager', name: secretIdFor },
  IMMUTABLE_ITEM_PER_VERSION: { adapter: 'onepassword', name: itemTitleFor },
  // The edge platform's environment, whose item name *is* the variable the
  // runtime reads — which is exactly why it cannot hold a second version of
  // one, and why this strategy exists.
  CURRENT_ONLY: { adapter: 'vercel', name: itemTitleFor },
};

export class FakeSecretStore implements SecretStore {
  readonly adapter: StoreAdapter;
  readonly pinning: PinningStrategy;

  /** Every `put`, in call order. */
  readonly puts: { scope: ConfigScope; key: string }[] = [];
  /** Every `destroy`, including the repeats that prove idempotence. */
  readonly destroyed: SecretReference[] = [];

  /** Keyed by the reference's own identity, so a lookup is what a read is. */
  private readonly stored = new Map<string, StoredVersion>();
  private readonly name: (scope: ConfigScope, key: string) => string;
  private counter = 0;

  constructor(options: FakeSecretStoreOptions = {}) {
    this.pinning = options.pinning ?? 'NATIVE';
    // The adapter follows the strategy unless a test says otherwise, so a store
    // constructed with only a pinning is never internally contradictory.
    this.adapter = options.adapter ?? STANDS_FOR[this.pinning].adapter;
    this.name = STANDS_FOR[this.pinning].name;
    if (this.pinning !== 'CURRENT_ONLY') {
      this.open = async (reference) =>
        this.stored.get(referenceId(reference))?.value ?? null;
    }
  }

  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    this.puts.push({ scope, key });
    this.counter += 1;
    const item = this.name(scope, key);

    // The strategies differ in where the version lives, and — for the third
    // one — in whether the version before it survives at all. NATIVE addresses
    // a numbered version of one item; IMMUTABLE_ITEM_PER_VERSION mints a fresh
    // item under the same name and reports the id it was given as the version.
    const reference: SecretReference =
      this.pinning === 'NATIVE'
        ? { key: item, version: String(this.counter) }
        : { key: item, version: `item-${this.counter}` };

    // CURRENT_ONLY holds one value per name because the name is the runtime's
    // own — so writing a new one is what *removes* the old, not something that
    // happens beside it. Modelled here rather than left to the real adapter,
    // because the conformance suite asserts this difference and a fake that
    // accumulated would let it pass against a store that cannot.
    if (this.pinning === 'CURRENT_ONLY') {
      for (const [id, held] of this.stored) {
        if (held.version.key === key) this.stored.delete(id);
      }
    }

    this.stored.set(referenceId(reference), {
      value,
      version: { reference, key, createdAt: new Date(this.counter) },
    });
    return reference;
  }

  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    return this.stored.get(referenceId(reference))?.version ?? null;
  }

  /**
   * A property rather than a method so it is genuinely absent under
   * `CURRENT_ONLY` — the real edge store has no read worth trusting, and a fake
   * that answered anyway would let dispatch's refusal go untested.
   * Assigned in the constructor, after the strategy it depends on is.
   */
  readonly open?: (reference: SecretReference) => Promise<string | null>;

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const item = this.name(scope, key);
    // Ordered by when it was written rather than by parsing the version, which
    // is a number under one strategy and an opaque minted id under the other.
    return [...this.stored.values()]
      .filter(({ version }) => version.reference.key === item)
      .map(({ version }) => version)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
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
