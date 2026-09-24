/**
 * The 1Password store, reached over Connect. Connect cannot address an item
 * version, so every `put` creates a new item and the item id is the version.
 */
import type { StoreAdapter } from '../../config/manifest.schema.ts';
import type {
  ConfigScope,
  PinningStrategy,
  SecretReference,
  SecretStore,
  SecretVersion,
} from './contract.ts';
import { type StoreEndpoint, StoreHttp } from './http.ts';

export interface OnePasswordStoreConfig extends StoreEndpoint {
  /** Connect addresses a vault by id. */
  readonly vault: string;
}

interface ConnectItemOverview {
  id: string;
  title: string;
  createdAt: string;
}

interface ConnectField {
  type?: string;
  label?: string;
  /** Only an item GET returns values. */
  value?: string;
  section?: { id?: string };
}

interface ConnectItem extends ConnectItemOverview {
  fields?: ConnectField[];
}

/**
 * Connect adds its category's default fields to a created item, one of them
 * `CONCEALED`. Those belong to no section, so this section marks our field.
 */
const SECTION = 'spindrift';

function itemTitle(scope: ConfigScope, key: string): string {
  return [scope.app, scope.component, scope.target, key].join('/');
}

/**
 * The label of the concealed field in {@link SECTION}, or `null` for an item
 * this adapter did not write.
 */
function keyOf(item: ConnectItem): string | null {
  for (const field of item.fields ?? []) {
    if (field.section?.id !== SECTION) continue;
    if (field.type !== 'CONCEALED') continue;
    if (field.label === undefined || field.label === '') continue;
    return field.label;
  }
  return null;
}

export class OnePasswordStore implements SecretStore {
  readonly adapter: StoreAdapter = 'onepassword';
  readonly pinning: PinningStrategy = 'IMMUTABLE_ITEM_PER_VERSION';

  private readonly http: StoreHttp;
  private readonly vault: string;

  constructor(config: OnePasswordStoreConfig) {
    this.http = new StoreHttp(config);
    this.vault = config.vault;
  }

  async put(
    scope: ConfigScope,
    key: string,
    value: string,
  ): Promise<SecretReference> {
    const title = itemTitle(scope, key);
    const created = await this.http.json<ConnectItem>({
      method: 'POST',
      path: `/v1/vaults/${encodeURIComponent(this.vault)}/items`,
      body: {
        vault: { id: this.vault },
        title,
        category: 'API_CREDENTIAL',
        sections: [{ id: SECTION, label: 'Spindrift' }],
        fields: [
          { type: 'CONCEALED', label: key, value, section: { id: SECTION } },
        ],
      },
    });

    if (created === null) {
      throw new Error(
        `1Password vault ${this.vault} does not exist or is not visible to this token`,
      );
    }

    return { key: title, version: created.id };
  }

  async describe(reference: SecretReference): Promise<SecretVersion | null> {
    const item = await this.http.json<ConnectItem>({
      method: 'GET',
      path: this.itemPath(reference.version),
    });
    if (item === null) return null;

    // A renamed item may fill a different variable, so it no longer resolves.
    if (item.title !== reference.key) return null;

    const key = keyOf(item);
    if (key === null) return null;

    return { reference, key, createdAt: new Date(item.createdAt) };
  }

  /** Build dispatch is the only caller. Same title check as `describe`. */
  async open(reference: SecretReference): Promise<string | null> {
    const item = await this.http.json<ConnectItem>({
      method: 'GET',
      path: this.itemPath(reference.version),
    });
    if (item === null || item.title !== reference.key) return null;

    for (const field of item.fields ?? []) {
      if (field.section?.id !== SECTION) continue;
      if (field.type !== 'CONCEALED') continue;
      return field.value ?? null;
    }
    return null;
  }

  async versions(scope: ConfigScope, key: string): Promise<SecretVersion[]> {
    const title = itemTitle(scope, key);
    const overviews =
      (await this.http.json<ConnectItemOverview[]>({
        method: 'GET',
        path:
          `/v1/vaults/${encodeURIComponent(this.vault)}/items` +
          `?filter=${encodeURIComponent(`title eq "${title}"`)}`,
      })) ?? [];

    // Refiltered: a Connect that ignores `filter` returns the whole vault.
    // Overviews carry no fields, so the key comes from the caller.
    return overviews
      .filter((item) => item.title === title)
      .map((item) => ({
        reference: { key: title, version: item.id },
        key,
        createdAt: new Date(item.createdAt),
      }))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async destroy(reference: SecretReference): Promise<void> {
    // `send` returns null on a 404, so destroying a missing item succeeds.
    await this.http.send({
      method: 'DELETE',
      path: this.itemPath(reference.version),
    });
  }

  private itemPath(itemId: string): string {
    return (
      `/v1/vaults/${encodeURIComponent(this.vault)}` +
      `/items/${encodeURIComponent(itemId)}`
    );
  }
}

export { itemTitle as itemTitleFor, SECTION as SPINDRIFT_SECTION };
