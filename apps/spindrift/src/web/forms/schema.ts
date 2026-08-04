/**
 * What a Zod schema looks like to a form, as data.
 *
 * The installation manifest is edited in the browser, and the reason this
 * module exists rather than a screen listing the fields is that **the schema
 * moves**. Deployment facts are being taken out of the manifest and derived
 * from the chart; discovery will take more out after that. A hand-listed form
 * survives none of those changes by failing — it survives them by silently
 * editing a key that no longer exists, or by never offering one that appeared.
 * Neither is visible until an installation is misconfigured.
 *
 * So the form is a projection of {@link describeSchema}. A key removed from the
 * schema stops being rendered on the next build, a key added starts being
 * rendered, and no screen has an opinion about which keys there are.
 *
 * **Deliberately a small vocabulary.** This describes the shapes the manifest
 * actually uses — objects, arrays, discriminated unions, enums, literals,
 * strings, numbers, booleans — and answers `unsupported` for anything else,
 * naming the Zod type it could not read. A general Zod-to-UI compiler would be
 * a much larger thing with no more coverage of this document, and an
 * `unsupported` node is rendered as a visible refusal rather than a silently
 * missing field, so the failure mode of meeting a new shape is a form that says
 * so.
 *
 * Zod 4 exposes `.def` on every schema; that is the whole of the reflection
 * used here, and it is read in one place so a Zod upgrade has one site to fix.
 */
import type { z } from 'zod';

/** A field's kind, and whatever rendering it needs beyond a label. */
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
      /** The key whose value picks a variant, for a discriminated union. */
      readonly discriminator: string | null;
      readonly variants: readonly FormVariant[];
    }
  | { readonly kind: 'unsupported'; readonly type: string };

/**
 * How a string is entered. `url` gets a URL input so a browser validates it
 * without this module restating the rule; everything else is text, because a
 * regex is the schema's to enforce and paraphrasing it in the UI is how the two
 * drift apart.
 */
export type StringFormat = 'text' | 'url';

/** One key of an object, with what may be done to it. */
export interface FormField {
  readonly key: string;
  /** The key, spaced and capitalized — `apexZone` reads as `Apex zone`. */
  readonly label: string;
  readonly node: FormNode;
  /** The key may be absent entirely. */
  readonly optional: boolean;
  /** The key may be present and `null`. */
  readonly nullable: boolean;
  /** The schema's own `.describe()` text, where it has one. */
  readonly description: string | null;
}

/** One arm of a union, named by its discriminator value where it has one. */
export interface FormVariant {
  readonly label: string;
  /** The discriminator value that selects this arm, or `null` if untagged. */
  readonly tag: string | null;
  readonly node: FormNode;
}

/** Zod 4's definition object, read structurally so no internal type is imported. */
interface Definition {
  readonly type: string;
  readonly shape?: Record<string, unknown>;
  readonly element?: unknown;
  readonly innerType?: unknown;
  /** A pipe's accepting end — what a document may say. See {@link describeSchema}. */
  readonly in?: unknown;
  readonly options?: readonly unknown[];
  readonly discriminator?: string;
  readonly entries?: Record<string, string | number>;
  readonly values?: readonly unknown[];
  readonly format?: string;
  readonly checks?: readonly unknown[];
}

/** The wrappers that say a value may be missing, null, or defaulted. */
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

/**
 * Peel `optional`, `nullable`, `default`, `readonly` and `nonoptional` off a
 * schema, remembering what they permit.
 *
 * A loop rather than recursion because the wrappers compose in any order and
 * the answer is the same either way — what matters to a form is only whether
 * absence and `null` are legal, never how many layers said so.
 */
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

/**
 * Describe a schema as a form node.
 *
 * Pure and total: every input answers something, and a shape this module does
 * not read answers `unsupported` with the Zod type name rather than throwing.
 * A form is not a place to discover that reflection failed.
 */
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
      // Zod 4 makes `.transform()` a pipe: an accepting schema, then a
      // function. The function is not a shape and never will be, so the half
      // worth describing is the accepting one — what a document is allowed to
      // *say*, which is exactly what a form edits and what re-validation runs
      // against. Describing the far end would mean describing a transform,
      // which is the `unsupported` this case exists to stop being the answer.
      return describeSchema(def.in);
    default:
      return { kind: 'unsupported', type: def.type };
  }
}

/**
 * Whether a string is a URL, asked both ways Zod can answer it.
 *
 * `z.url()` puts the format on the definition; `z.string().url()` puts the same
 * fact in a check. The manifest schema uses both spellings, and a form that
 * read only one of them would offer a plain text box for half its URLs.
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
 * `T | T[]` described as `T[]`, which is the only thing it ever meant.
 *
 * An untagged union in this schema is not a choice an operator makes — it is a
 * document being allowed to spell one value two ways. `supplyChain.registry` is
 * the case and its own comment is the rule: "A bare string is the same document
 * as a one-element list and stays legal, so an installation with one registry
 * says one thing and no stored manifest needs rewriting to keep parsing." The
 * narrow arm exists for documents already written; the wide arm is what the
 * value *is*, and it is what the transform on the far side of the pipe produces
 * either way.
 *
 * So a form offers the list. The alternative is a variant selector asking an
 * operator whether they would like to type one registry or several — a question
 * about a spelling, in front of somebody configuring an installation for the
 * first time.
 *
 * `null` for anything else, deliberately: this recognises exactly the shape it
 * describes, by comparing the array arm's element against the other arm rather
 * than by trusting the order they were declared in. A genuine untagged union of
 * two unrelated shapes stays a union and keeps whatever the union control makes
 * of it — being unable to render one honestly is a better answer than rendering
 * the wrong arm of it.
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
  // FormNodes are plain, acyclic data built above in one canonical property
  // order, so their JSON representation is their structural identity. Keep
  // this browser-owned module independent of Bun's server runtime.
  return JSON.stringify(list.node.element) === JSON.stringify(single.node)
    ? list.node
    : null;
}

/** The literal value an arm pins its discriminator to. */
function tagOf(
  node: FormNode,
  discriminator: string,
  index: number,
): string | null {
  if (node.kind !== 'object') return null;
  const field = node.fields.find((each) => each.key === discriminator);
  return field?.node.kind === 'literal' ? field.node.value : String(index);
}

/**
 * The fields of an object schema, or an empty list for anything else.
 *
 * A convenience for the one caller that starts from the manifest's own root and
 * wants sections rather than a single nested control.
 */
export function describeObject(schema: z.ZodType): readonly FormField[] {
  const node = describeSchema(schema);
  return node.kind === 'object' ? node.fields : [];
}
