/**
 * A fake secret store under any pinning strategy, keyed by the real stores'
 * naming functions. Values come back only through `open`, which `CURRENT_ONLY`
 * lacks.
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
  /** Returned by `open`, and by `written` for a test. */
  value: string;
}

export interface FakeSecretStoreOptions {
  adapter?: StoreAdapter;
  pinning?: PinningStrategy;
}

/** The real store each strategy stands for. */
const STANDS_FOR: Record<
  PinningStrategy,
  { adapter: StoreAdapter; name: (scope: ConfigScope, key: string) => string }
> = {
  NATIVE: { adapter: 'gcp-secret-manager', name: secretIdFor },
  IMMUTABLE_ITEM_PER_VERSION: { adapter: 'onepassword', name: itemTitleFor },
  // The edge platform names an item by the variable the runtime reads, so it
  // holds one version of each.
  CURRENT_ONLY: { adapter: 'vercel', name: itemTitleFor },
};

export class FakeSecretStore implements SecretStore {
  readonly adapter: StoreAdapter;
  readonly pinning: PinningStrategy;

  readonly puts: { scope: ConfigScope; key: string }[] = [];
  /** Every `destroy`, repeats included. */
  readonly destroyed: SecretReference[] = [];

  private readonly stored = new Map<string, StoredVersion>();
  private readonly name: (scope: ConfigScope, key: string) => string;
  private counter = 0;

  constructor(options: FakeSecretStoreOptions = {}) {
    this.pinning = options.pinning ?? 'NATIVE';
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

    // NATIVE numbers versions of one item; the others report a minted item id.
    const reference: SecretReference =
      this.pinning === 'NATIVE'
        ? { key: item, version: String(this.counter) }
        : { key: item, version: `item-${this.counter}` };

    // CURRENT_ONLY keeps one value per key, as the conformance suite asserts.
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

  /** Absent under `CURRENT_ONLY`, as on the real edge store. */
  readonly open?: (reference: SecretReference) => Promise<string | null>;

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const item = this.name(scope, key);
    // By write time, since only NATIVE versions are numbers.
    return [...this.stored.values()]
      .filter(({ version }) => version.reference.key === item)
      .map(({ version }) => version)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async destroy(reference: SecretReference): Promise<void> {
    this.destroyed.push(reference);
    this.stored.delete(referenceId(reference));
  }

  /** Test-only read of a written value; not a contract verb. */
  written(reference: SecretReference): string | null {
    return this.stored.get(referenceId(reference))?.value ?? null;
  }
}

function referenceId(reference: SecretReference): string {
  return `${reference.key}#${reference.version}`;
}
