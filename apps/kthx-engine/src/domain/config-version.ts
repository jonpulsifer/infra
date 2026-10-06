/**
 * `configVersion`: the hash a Deploy carries in place of its config. It covers
 * pinned references, never values, and an empty document has a version too.
 */
import type { ConfigEntry, SecretReference } from './desired-state.ts';

/** The shape of `DesiredState.config`, so what is hashed is what the adapter gets. */
export type ConfigDocument = readonly ConfigEntry[];

/** Sorted by variable name, which `config_items` keeps unique within one scope. */
export function canonicalConfigDocument(
  entries: ConfigDocument,
): ConfigEntry[] {
  return [...entries]
    .map((entry) => ({
      name: entry.name,
      secret: { key: entry.secret.key, version: entry.secret.version },
    }))
    .sort((left, right) => (left.name < right.name ? -1 : 1));
}

/** `sha256:<hex>` over the canonical JSON, stable because every field is a string in a fixed order. */
export async function configVersionOf(
  entries: ConfigDocument,
): Promise<string> {
  const canonical = canonicalConfigDocument(entries).map((entry) => [
    entry.name,
    entry.secret.key,
    entry.secret.version,
  ]);
  const bytes = new TextEncoder().encode(JSON.stringify(canonical));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = Array.from(hash, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha256:${hex}`;
}

/** A config row, read without its value. */
export interface PinnedItem {
  readonly key: string;
  readonly storeRef: string | null;
  readonly storeVersion: string | null;
}

/**
 * Drops a row with half a pin: no version would float, and no item cannot
 * resolve. The commands always write both columns together.
 */
export function documentOf(items: readonly PinnedItem[]): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const item of items) {
    if (item.storeRef === null || item.storeVersion === null) continue;
    const secret: SecretReference = {
      key: item.storeRef,
      version: item.storeVersion,
    };
    entries.push({ name: item.key, secret });
  }
  return canonicalConfigDocument(entries);
}
