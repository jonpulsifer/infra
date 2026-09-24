/**
 * A Zod 4 schema described as data, so a form renders whatever keys the schema
 * declares. An `unsupported` node renders as a visible refusal.
 */
import type { z } from 'zod';

export type FormNode =
  | { readonly kind: 'string'; readonly format: StringFormat }
  | { readonly kind: 'number'; readonly integer: boolean }
  | { readonly kind: 'boolean' }
  | { readonly kind: 'enum'; readonly values: readonly string[] }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'object'; readonly fields: readonly FormField[] }
  | { readonly kind: 'array'; readonly element: FormNode }
  | {
      readonly kind: 'union';
      /** `null` for an untagged union. */
      readonly discriminator: string | null;
      readonly variants: readonly FormVariant[];
    }
  | { readonly kind: 'unsupported'; readonly type: string };

/** `url` gets an input the browser validates; other rules stay the schema's. */
export type StringFormat = 'text' | 'url';

export interface FormField {
  readonly key: string;
  readonly label: string;
  readonly node: FormNode;
  /** The key may be absent. */
  readonly optional: boolean;
  /** The key may be present and `null`. */
  readonly nullable: boolean;
  /** The schema's own `.describe()` text, where it has one. */
  readonly description: string | null;
}

export interface FormVariant {
  readonly label: string;
  /** `null` for an untagged union. */
  readonly tag: string | null;
  readonly node: FormNode;
}

/** Zod 4's `.def`, typed structurally so no internal type is imported. */
interface Definition {
  readonly type: string;
  readonly shape?: Record<string, unknown>;
  readonly element?: unknown;
  readonly innerType?: unknown;
  /** A pipe's input schema. */
  readonly in?: unknown;
  readonly options?: readonly unknown[];
  readonly discriminator?: string;
  readonly entries?: Record<string, string | number>;
  readonly values?: readonly unknown[];
  readonly format?: string;
  readonly checks?: readonly unknown[];
}

interface Wrapping {
  readonly optional: boolean;
  readonly nullable: boolean;
  readonly schema: unknown;
}

function definitionOf(schema: unknown): Definition | null {
  const def = (schema as { def?: unknown } | null)?.def;
  return def !== null && typeof def === 'object' ? (def as Definition) : null;
}

function descriptionOf(schema: unknown): string | null {
  const described = (schema as { description?: unknown }).description;
  return typeof described === 'string' ? described : null;
}

/** A defaulted key may be absent, so `default` counts as optional. */
function unwrap(schema: unknown): Wrapping {
  let optional = false;
  let nullable = false;
  let current = schema;
  for (;;) {
    const def = definitionOf(current);
    if (def === null) return { optional, nullable, schema: current };
    switch (def.type) {
      case 'optional':
      case 'default':
      case 'prefault':
        optional = true;
        break;
      case 'nullable':
        nullable = true;
        break;
      case 'nonoptional':
        optional = false;
        break;
      case 'readonly':
        break;
      default:
        return { optional, nullable, schema: current };
    }
    if (def.innerType === undefined) {
      return { optional, nullable, schema: current };
    }
    current = def.innerType;
  }
}

/** `apexZone` → `Apex zone`; `zeroConfigFrontend` → `Zero config frontend`. */
export function humanize(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .toLowerCase()
    .trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Never throws: a shape it cannot read is `unsupported`, naming the type. */
export function describeSchema(schema: unknown): FormNode {
  const def = definitionOf(schema);
  if (def === null) return { kind: 'unsupported', type: 'unknown' };

  switch (def.type) {
    case 'string':
      return { kind: 'string', format: stringFormat(def) };
    case 'number':
    case 'int':
      return { kind: 'number', integer: def.type === 'int' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'enum':
      return { kind: 'enum', values: Object.keys(def.entries ?? {}) };
    case 'literal': {
      const [value] = def.values ?? [];
      return { kind: 'literal', value: String(value ?? '') };
    }
    case 'object':
      return { kind: 'object', fields: fieldsOf(def.shape ?? {}) };
    case 'array':
      return { kind: 'array', element: describeSchema(def.element) };
    case 'union':
      return unionNode(def);
    case 'pipe':
      // Zod 4 makes `.transform()` a pipe. Its input side is what a document
      // may say, which is what the form edits.
      return describeSchema(def.in);
    default:
      return { kind: 'unsupported', type: def.type };
  }
}

/**
 * `z.url()` puts the format on the definition and `z.string().url()` puts it in
 * a check. The manifest schema uses both.
 */
function stringFormat(def: Definition): StringFormat {
  if (def.format === 'url') return 'url';
  for (const check of def.checks ?? []) {
    const inner = (check as { _zod?: { def?: { format?: string } } })._zod?.def;
    if (inner?.format === 'url') return 'url';
  }
  return 'text';
}

function fieldsOf(shape: Record<string, unknown>): readonly FormField[] {
  return Object.entries(shape).map(([key, value]) => {
    const { optional, nullable, schema } = unwrap(value);
    return {
      key,
      label: humanize(key),
      node: describeSchema(schema),
      optional,
      nullable,
      description: descriptionOf(value) ?? descriptionOf(schema),
    };
  });
}

function unionNode(def: Definition): FormNode {
  const discriminator = def.discriminator ?? null;
  const variants = (def.options ?? []).map((option, index): FormVariant => {
    const node = describeSchema(option);
    const tag =
      discriminator === null ? null : tagOf(node, discriminator, index);
    return {
      tag,
      label: tag === null ? `Option ${index + 1}` : humanize(tag),
      node,
    };
  });
  return (
    oneOrMany(discriminator, variants) ?? {
      kind: 'union',
      discriminator,
      variants,
    }
  );
}

/**
 * `T | T[]` is described as `T[]`: the bare arm is another spelling of a
 * one-element list. `null` for any other union.
 */
function oneOrMany(
  discriminator: string | null,
  variants: readonly FormVariant[],
): FormNode | null {
  if (discriminator !== null || variants.length !== 2) return null;
  const list = variants.find((variant) => variant.node.kind === 'array');
  const single = variants.find((variant) => variant.node.kind !== 'array');
  if (list === undefined || single === undefined) return null;
  if (list.node.kind !== 'array') return null;
  // FormNodes are acyclic and built in one property order, so equal JSON is an
  // equal shape. This module runs in the browser, so no Bun deep-equal.
  return JSON.stringify(list.node.element) === JSON.stringify(single.node)
    ? list.node
    : null;
}

/** The arm's index when its discriminator is not a literal. */
function tagOf(
  node: FormNode,
  discriminator: string,
  index: number,
): string | null {
  if (node.kind !== 'object') return null;
  const field = node.fields.find((each) => each.key === discriminator);
  return field?.node.kind === 'literal' ? field.node.value : String(index);
}

export function describeObject(schema: z.ZodType): readonly FormField[] {
  const node = describeSchema(schema);
  return node.kind === 'object' ? node.fields : [];
}
