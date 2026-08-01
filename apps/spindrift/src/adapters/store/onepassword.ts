/**
 * The 1Password store, reached over Connect (§10).
 *
 * §10 describes this installation shape exactly: "a store is its store of record
 * plus one or more access paths. Both clusters run their own connect service in
 * front of the same vault, which is why cluster-to-cluster re-placement is free."
 * The store of record is the vault; a Connect service is one access path to it.
 * This adapter therefore takes a base URL and a vault, and neither of them is a
 * literal here — {@link OnePasswordStore} is constructed from configuration.
 *
 * **Why this store pins by minting an item.** Connect exposes item *versions* in
 * its metadata but gives no way to address one: `GET .../items/{id}` returns
 * whatever the item says today. A reference into it would therefore be a floating
 * latest, which §10 forbids. So this is the `IMMUTABLE_ITEM_PER_VERSION`
 * strategy the spec names: every `put` creates a **new item**, and the item's own
 * uuid *is* the version. §10 calls that "more portable, not less", and the
 * conformance suite is what holds it to that — it runs the same assertions
 * against this and against the natively-versioned store, and neither is allowed
 * to be special.
 *
 * Two consequences worth stating, because they are the reason this is not a
 * loop over a counter:
 *
 * - A version number derived by counting existing items would race: two
 *   concurrent puts would both count `n` and both write `n + 1`. The uuid the
 *   far side mints cannot collide, so ordering is read from `createdAt` rather
 *   than encoded in the name.
 * - Items are addressed by a title Spindrift owns, `app/component/target/KEY`,
 *   which exists so an operator reading the vault can see what a value is for.
 *   It is **not** what the adapter reads back: the variable a version fills
 *   comes from the label of the concealed field in {@link SECTION}, the same
 *   rule the cloud store follows with an annotation. A name is for humans;
 *   metadata is the authority.
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

/** Where this installation's Connect service is, and which vault it fronts. */
export interface OnePasswordStoreConfig extends StoreEndpoint {
  /** The vault of record. One vault per installation (§10: one store). */
  readonly vault: string;
}

/** The subset of a Connect item overview this adapter reads. */
interface ConnectItemOverview {
  id: string;
  title: string;
  createdAt: string;
}

/** The subset of one field of a Connect item this adapter reads. */
interface ConnectField {
  type?: string;
  label?: string;
  section?: { id?: string };
}

/** The subset of a full Connect item this adapter reads. */
interface ConnectItem extends ConnectItemOverview {
  fields?: ConnectField[];
}

/**
 * The section every field this adapter writes lives in, and the marker
 * {@link keyOf} reads an item back by.
 *
 * Connect populates a created item with its **category's default fields** —
 * `username`, `credential`, `notesPlain` on an `API_CREDENTIAL` — that the
 * caller never sent. Several of them carry a label and one of them is
 * `CONCEALED`, so neither position nor type alone distinguishes the field
 * Spindrift wrote from one Connect invented. A section does: a category default
 * belongs to no section, and this id is Spindrift's own.
 */
const SECTION = 'spindrift';

/**
 * The item title for one scoped variable. Spindrift's naming, not the store's —
 * §10 leaves "how it becomes an item name" to the adapter, which is what lets
 * one vault back several Targets.
 */
function itemTitle(scope: ConfigScope, key: string): string {
  return [scope.app, scope.component, scope.target, key].join('/');
}

/**
 * The variable an item fills, as `put` was given it.
 *
 * The label of the concealed field in {@link SECTION} is where `put` wrote it,
 * so an item without one is an item this adapter did not write — reported as
 * absent rather than guessed at from the title, and never mistaken for a field
 * the category brought with it.
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
      // A 404 on the create path means the vault itself is not there, which is
      // a fault rather than an absence — the only place in this adapter where
      // `null` from the transport is not an answer.
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

    // An item whose title moved is no longer the version this reference names.
    // Reporting it anyway would let a rename silently re-point a pinned Deploy
    // at a different variable.
    if (item.title !== reference.key) return null;

    const key = keyOf(item);
    if (key === null) return null;

    return { reference, key, createdAt: new Date(item.createdAt) };
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

    // The filter is sent because Connect supports it and a vault can be large;
    // the same predicate is applied here because a Connect that ignored it
    // would otherwise return the whole vault as versions of one key.
    //
    // The `key` attached is the caller's rather than one read back, because a
    // list answers with overviews and no fields. That cannot disagree with what
    // `describe` reads: `put` derives the title from the key, so an item that
    // matches this title is an item whose section field is labelled `key`.
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
    // `send` returns null on a 404, which is exactly the idempotence the
    // contract asks for: destroying what is already gone succeeds.
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
