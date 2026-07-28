/**
 * `configVersion` — the hash a Deploy carries instead of the config itself
 * (§10).
 *
 * §10: "**`configVersion` is a hash over a document of pinned version
 * references**, never a floating 'latest', and is **scoped to (Component,
 * Target)**. A config change produces a new Deploy — not bookkeeping, since it
 * would otherwise silently not apply on Kubernetes — and costs no new noun,
 * because `configVersion` is a *field* on Deploy. That makes a Deploy exactly
 * Heroku's Release."
 *
 * Three properties this file exists to hold, each of which is a way the hash
 * could be wrong without anything noticing:
 *
 * - **It hashes references, never values.** Core has none to hash: values are
 *   write-only and cross the store seam in one direction (§10). A hash over
 *   values would also be a hash that changes when nothing about the delivery
 *   did, which is a rollout for no reason.
 * - **It is order-insensitive.** The document is canonicalized by variable name
 *   first, so two reads of the same config items that happened to come back in
 *   different row order produce the same version. Without that, the loop that
 *   compares versions would deploy on every pass.
 * - **It is total.** An empty document has a version too. "No config" is a
 *   state a Deploy can be pinned to, and a rollback to it must be able to say
 *   so — a `null` there would be indistinguishable from "not recorded".
 */
import type { ConfigEntry, SecretReference } from './desired-state.ts';

/**
 * The pinned document itself: every variable a Component@Target delivers, and
 * the exact stored version filling each one.
 *
 * The same shape `DesiredState.config` takes, deliberately — the document a
 * Deploy records *is* what the adapter is later handed, so there is no second
 * rendering step between what was hashed and what was delivered.
 */
export type ConfigDocument = readonly ConfigEntry[];

/**
 * The document, in the one order its hash is defined over.
 *
 * Sorted by variable name, which is unique within a (Component, Target) scope
 * because the `config_items` unique key says so. Sorting by anything else —
 * store key, insertion order — would be sorting by something two equal
 * documents are allowed to disagree about.
 */
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

/**
 * `sha256:<hex>` over the canonical document.
 *
 * The serialization is the canonical form rendered as JSON, which is stable
 * here because every field is a string and the key order is written out
 * literally below rather than left to whatever built the object.
 */
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

/** One config row, as this module reads it — never its value. */
export interface PinnedItem {
  readonly key: string;
  readonly storeRef: string | null;
  readonly storeVersion: string | null;
}

/**
 * Turn stored rows into the document a Deploy pins.
 *
 * A row whose pin is incomplete is **dropped rather than delivered as a
 * half-reference**: an entry naming an item with no version would be the
 * floating latest §10 forbids, and one naming a version with no item cannot be
 * resolved by anything. Neither can happen through the commands — both columns
 * are written from one `put` — so a dropped row means something wrote around
 * them, and delivering it anyway is how that becomes a workload holding the
 * wrong secret.
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
