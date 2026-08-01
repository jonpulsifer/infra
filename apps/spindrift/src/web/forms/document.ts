/**
 * Editing a JSON document by path, without a form library.
 *
 * The manifest is one document that is valid or is not — `configureInstallation`
 * takes the whole thing for that reason — so the editing model here is a
 * document and a cursor into it, never a bag of per-field states. Two properties
 * follow that are worth having on purpose:
 *
 * 1. **What is submitted is what was read, plus edits.** A key this build's
 *    schema does not render is carried through untouched rather than dropped,
 *    so an older UI cannot silently delete a key a newer server requires. The
 *    schema decides what is *editable*; it does not decide what is *kept*.
 * 2. **Every edit is a whole new document.** React re-renders on identity, and
 *    a mutation in place is the bug where a field types and nothing moves.
 *
 * Absence and `null` are different states and both are reachable: a manifest key
 * may be optional, nullable, or neither, and flattening the two would make
 * "this installation has no Gateway" indistinguishable from "this build of the
 * form did not know about Gateways".
 */
import type { FormNode, FormVariant } from './schema.ts';

/** Where a value sits: object keys and array indices, outermost first. */
export type Path = readonly (string | number)[];

/** A path rendered for an input's `name`, and for keying an error to a field. */
export function pathKey(path: Path): string {
  return path.map(String).join('.');
}

/** The value at a path, or `undefined` where nothing is there. */
export function valueAt(document: unknown, path: Path): unknown {
  let current = document;
  for (const step of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string | number, unknown>)[step];
  }
  return current;
}

/** The document with `value` at `path`, and every container along it replaced. */
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

/** The document with whatever is at `path` removed — a key, or an array item. */
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
 * A value of the right shape, with nothing filled in.
 *
 * What "nothing" means is the schema's answer, not a convention: an enum's
 * first member, a literal's only legal value, an object carrying exactly its
 * required keys. Optional keys are left out, because a blank optional key is a
 * value the operator did not choose and the schema does not require.
 *
 * Blank strings are what make the form's own validation say something useful:
 * an empty required string fails `min(1)` and is reported against its own path,
 * which is a better sentence than a missing key's.
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

/**
 * Which arm of a discriminated union a value is currently in.
 *
 * By the discriminator's value rather than by trial parse: a half-edited object
 * matches no arm cleanly, and a form that lost track of which variant it was
 * showing every time the value was momentarily invalid would be unusable.
 */
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
 * Move a value to another arm of a union, keeping what both arms declare.
 *
 * The rule is the schema's, not a list of field names: a key the new arm also
 * has keeps its value unless it is the discriminator or a literal, both of
 * which the arm itself decides. So changing a Target from one adapter to
 * another keeps its name and discards the connection facts that only meant
 * something to the old adapter — without this module knowing that Targets have
 * names.
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
