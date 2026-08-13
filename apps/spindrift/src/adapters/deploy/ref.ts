/**
 * How a boundary-scoped adapter spells its {@link DeployRef}.
 *
 * `<scope>/<collection>/<id>` — the boundary the placement lives in, the kind
 * of thing it is, and its name. Four adapters had written the same pair
 * privately, and what matters is in the parse rather than the format: core
 * stores the string opaquely and hands it back later, by which time an operator
 * may have re-pointed the Target at another account, so a ref naming a scope
 * this connection is not answers `null` rather than an id that would be acted
 * on in the wrong boundary. An id carrying a `/` answers `null` for the same
 * reason — it is a ref of some other shape, not a name to truncate.
 *
 * Not every ref is this shape: the Kubernetes one carries a delivery flavour
 * and a namespaced name, and says so in its own two functions. So this is a
 * helper the adapters that already agreed on a shape call, and not a format the
 * contract imposes on the seam.
 */
import type { DeployRef } from './contract.ts';

/** The adapter's own handle on what `apply` placed — opaque to core (§6). */
export function scopedRef(
  scope: string,
  collection: string,
  id: string,
): DeployRef {
  return `${scope}/${collection}/${id}`;
}

/** The id this ref names in that collection, or `null` if it names another's. */
export function parseScopedRef(
  scope: string,
  collection: string,
  ref: DeployRef,
): string | null {
  const prefix = `${scope}/${collection}/`;
  if (!ref.startsWith(prefix)) return null;
  const id = ref.slice(prefix.length);
  return id.length === 0 || id.includes('/') ? null : id;
}
