/**
 * How a boundary-scoped adapter spells its {@link DeployRef}:
 * `<scope>/<collection>/<id>`.
 */
import type { DeployRef } from './contract.ts';

export function scopedRef(
  scope: string,
  collection: string,
  id: string,
): DeployRef {
  return `${scope}/${collection}/${id}`;
}

/**
 * The id this ref names in that collection, or `null` when it names none there.
 * A Target may be re-pointed at another account after its refs were stored.
 */
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
