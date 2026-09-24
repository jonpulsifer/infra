/**
 * Editing a JSON document by path. A key the schema does not render is carried
 * through, so an older UI cannot drop a key a newer server requires. Every edit
 * returns a new document, and absence stays distinct from `null`.
 */
import type { FormNode, FormVariant } from './schema.ts';

/** Object keys and array indices, outermost first. */
export type Path = readonly (string | number)[];

export function pathKey(path: Path): string {
  return path.map(String).join('.');
}

export function valueAt(document: unknown, path: Path): unknown {
  let current = document;
  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/** Copies every container along the path, creating any that is missing. */
export function withValueAt(
  document: unknown,
  path: Path,
  value: unknown,
): unknown {
  if (path.length === 0) return value;
  const [step, ...rest] = path as [string | number, ...Path];
  if (typeof step === 'number') {
    const list = Array.isArray(document) ? document : [];
    const next = list.slice();
    next[step] = withValueAt(list[step], rest, value);
    return next;
  }
  const object =
    document !== null &&
    typeof document === 'object' &&
    !Array.isArray(document)
      ? (document as Record<string, unknown>)
      : {};
  return { ...object, [step]: withValueAt(object[step], rest, value) };
}

export function withoutValueAt(document: unknown, path: Path): unknown {
  if (path.length === 0) return undefined;
  const [step, ...rest] = path as [string | number, ...Path];
  if (rest.length > 0) {
    const inner = withoutValueAt(valueAt(document, [step]), rest);
    return withValueAt(document, [step], inner);
  }
  if (typeof step === 'number') {
    const list = Array.isArray(document) ? document : [];
    return list.filter((_, index) => index !== step);
  }
  if (document === null || typeof document !== 'object') return document;
  const { [step]: _removed, ...kept } = document as Record<string, unknown>;
  return kept;
}

/**
 * A value of the right shape with nothing filled in. Optional keys are left
 * out, and an empty required string fails `min(1)` against its own path.
 */
export function blankValue(node: FormNode): unknown {
  switch (node.kind) {
    case 'string':
      return '';
    case 'number':
      return 0;
    case 'boolean':
      return false;
    case 'enum':
      return node.values[0] ?? '';
    case 'literal':
      return node.value;
    case 'array':
      return [];
    case 'object': {
      const value: Record<string, unknown> = {};
      for (const field of node.fields) {
        if (field.optional) continue;
        value[field.key] = field.nullable ? null : blankValue(field.node);
      }
      return value;
    }
    case 'union': {
      const [first] = node.variants;
      return first === undefined ? null : blankValue(first.node);
    }
    case 'unsupported':
      return null;
  }
}

/** Matched by discriminator, since a half-edited value parses as no arm. */
export function variantOf(
  variants: readonly FormVariant[],
  discriminator: string | null,
  value: unknown,
): FormVariant | undefined {
  if (discriminator === null) return variants[0];
  const tag = (value as Record<string, unknown> | null)?.[discriminator];
  return variants.find((variant) => variant.tag === tag);
}

/**
 * Keeps each key the new arm also declares, except literals such as the
 * discriminator, which the new arm sets.
 */
export function switchVariant(value: unknown, to: FormVariant): unknown {
  const blank = blankValue(to.node);
  if (
    to.node.kind !== 'object' ||
    blank === null ||
    typeof blank !== 'object' ||
    value === null ||
    typeof value !== 'object'
  ) {
    return blank;
  }
  const carried: Record<string, unknown> = {
    ...(blank as Record<string, unknown>),
  };
  const previous = value as Record<string, unknown>;
  for (const field of to.node.fields) {
    if (field.node.kind === 'literal') continue;
    if (!Object.hasOwn(previous, field.key)) continue;
    carried[field.key] = previous[field.key];
  }
  return carried;
}
