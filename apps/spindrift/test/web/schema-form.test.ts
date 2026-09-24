// The settings form derives its keys from the manifest schema, so a key the
// schema gains or drops needs no edit to the form.
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { installationManifestSchema } from '../../src/config/manifest.schema.ts';
import {
  blankValue,
  pathKey,
  switchVariant,
  valueAt,
  variantOf,
  withoutValueAt,
  withValueAt,
} from '../../src/web/forms/document.ts';
import { manifestFields } from '../../src/web/forms/manifest.ts';
import {
  describeObject,
  describeSchema,
  type FormField,
  type FormNode,
  humanize,
} from '../../src/web/forms/schema.ts';

function schemaKeys(schema: z.ZodType): string[] {
  const shape = (
    schema as unknown as { def: { shape: Record<string, unknown> } }
  ).def.shape;
  return Object.keys(shape);
}

function field(fields: readonly FormField[], key: string): FormField {
  const found = fields.find((each) => each.key === key);
  if (found === undefined) throw new Error(`no field named ${key}`);
  return found;
}

describe('the form is the schema', () => {
  test('offers exactly the keys the manifest schema declares', () => {
    expect(manifestFields().map((each) => each.key)).toEqual(
      schemaKeys(installationManifestSchema),
    );
  });

  test('offers them in the schema’s own order', () => {
    const [first] = manifestFields();
    expect(first?.key).toBe(schemaKeys(installationManifestSchema)[0]);
  });

  test('drops a key the schema drops, with no edit here', () => {
    const before = z.object({ kept: z.string(), leaving: z.string() });
    const after = z.object({ kept: z.string() });

    expect(describeObject(before).map((each) => each.key)).toEqual([
      'kept',
      'leaving',
    ]);
    expect(describeObject(after).map((each) => each.key)).toEqual(['kept']);
  });

  test('offers a key the schema gains, with no edit here', () => {
    const grown = z.object({ kept: z.string(), arrived: z.string() });
    expect(describeObject(grown).map((each) => each.key)).toContain('arrived');
  });
});

describe('what a field knows about itself', () => {
  const fields = manifestFields();

  test('a nested object becomes a group of its own keys', () => {
    const dns = field(fields, 'dns').node;
    expect(dns.kind).toBe('object');
    if (dns.kind !== 'object') return;
    expect(dns.fields.map((each) => each.key).sort()).toEqual(
      schemaKeys(
        (
          installationManifestSchema as unknown as {
            def: { shape: Record<string, z.ZodType> };
          }
        ).def.shape.dns as z.ZodType,
      ).sort(),
    );
  });

  test('a nullable key is togglable and a required one is not', () => {
    const auth = field(fields, 'auth').node;
    expect(auth.kind).toBe('object');
    if (auth.kind !== 'object') return;
    // `auth.gateway` is null when passkeys are the only sign-in path.
    expect(field(auth.fields, 'gateway').nullable).toBe(true);
    expect(field(fields, 'installation').nullable).toBe(false);
    expect(field(fields, 'installation').optional).toBe(false);
  });

  test('an optional key is marked optional', () => {
    const supplyChain = field(fields, 'supplyChain').node;
    if (supplyChain.kind !== 'object') {
      throw new Error('supplyChain is not an object');
    }
    expect(field(supplyChain.fields, 'attestor').optional).toBe(true);
    expect(field(supplyChain.fields, 'signer').optional).toBe(false);
  });

  test('an enum becomes its own members, read from the schema', () => {
    const store = field(fields, 'secretStore').node;
    if (store.kind !== 'object')
      throw new Error('secretStore is not an object');
    const adapter = field(store.fields, 'adapter').node;
    expect(adapter.kind).toBe('enum');
    if (adapter.kind !== 'enum') return;
    expect(adapter.values.length).toBeGreaterThan(1);
  });

  test('a discriminated union becomes a choice plus the arm’s own keys', () => {
    const targets = field(fields, 'targets').node;
    expect(targets.kind).toBe('array');
    if (targets.kind !== 'array') return;
    const element = targets.element;
    expect(element.kind).toBe('union');
    if (element.kind !== 'union') return;
    expect(element.discriminator).toBe('adapter');
    expect(element.variants.every((variant) => variant.tag !== null)).toBe(
      true,
    );
  });

  test('a url string is entered as a url', () => {
    const store = field(fields, 'secretStore').node;
    if (store.kind !== 'object')
      throw new Error('secretStore is not an object');
    const endpoint = field(store.fields, 'endpoint').node;
    expect(endpoint).toEqual({ kind: 'string', format: 'url' });
  });

  test('a url is a url in either spelling the schema uses', () => {
    // `z.url()` puts the format on the definition and `z.string().url()` in a
    // check. The manifest schema uses both.
    expect(describeSchema(z.url())).toEqual({ kind: 'string', format: 'url' });
    expect(describeSchema(z.string().url())).toEqual({
      kind: 'string',
      format: 'url',
    });
  });

  test('a shape this module cannot read says so rather than disappearing', () => {
    // A field that silently vanished would be a key nobody could configure.
    const node = describeSchema(z.map(z.string(), z.string()));
    expect(node.kind).toBe('unsupported');
  });

  test('a key reads as a sentence, not as an identifier', () => {
    expect(humanize('zeroConfigFrontend')).toBe('Zero config frontend');
    expect(humanize('tunnelHostname')).toBe('Tunnel hostname');
  });

  test('a one-or-many key is the list it always was', () => {
    // `supplyChain.registry` accepts a string or a list and transforms both to a list.
    const supplyChain = field(fields, 'supplyChain').node;
    if (supplyChain.kind !== 'object')
      throw new Error('supplyChain is not an object');
    const registry = field(supplyChain.fields, 'registry');
    expect(registry.node).toEqual({
      kind: 'array',
      element: { kind: 'string', format: 'text' },
    });
  });

  test('an untagged union of unrelated shapes is left alone', () => {
    // Only a union of a type and a list of it collapses to a list.
    const node = describeSchema(z.union([z.string(), z.array(z.number())]));
    expect(node.kind).toBe('union');
  });
});

describe('editing the document', () => {
  const node: FormNode = describeSchema(
    z.object({
      name: z.string(),
      note: z.string().optional(),
      list: z.array(z.string()),
    }),
  );

  test('a set replaces the document rather than mutating it', () => {
    const before = { a: { b: 'one' } };
    const after = withValueAt(before, ['a', 'b'], 'two');
    expect(before.a.b).toBe('one');
    expect(valueAt(after, ['a', 'b'])).toBe('two');
  });

  test('a key this build does not render survives the edit', () => {
    // The schema decides what is editable, never what is kept, so an older UI
    // cannot drop a newer server's keys.
    const before = { known: 'one', unknown: 'kept' };
    const after = withValueAt(before, ['known'], 'two');
    expect(valueAt(after, ['unknown'])).toBe('kept');
  });

  test('removing a key and removing an array item are different acts', () => {
    expect(withoutValueAt({ a: 1, b: 2 }, ['b'])).toEqual({ a: 1 });
    expect(withoutValueAt({ list: [1, 2, 3] }, ['list', 1])).toEqual({
      list: [1, 3],
    });
  });

  test('a blank value carries the required keys and omits the optional ones', () => {
    expect(blankValue(node)).toEqual({ name: '', list: [] });
  });

  test('a path keys a control and an error the same way', () => {
    expect(pathKey(['targets', 1, 'name'])).toBe('targets.1.name');
  });
});

describe('changing which kind of thing a value is', () => {
  const union = describeSchema(
    z.discriminatedUnion('adapter', [
      z.object({
        name: z.string(),
        adapter: z.literal('one'),
        only: z.string(),
      }),
      z.object({ name: z.string(), adapter: z.literal('two') }),
    ]),
  );

  test('finds the arm by its discriminator, not by trial parse', () => {
    if (union.kind !== 'union') throw new Error('not a union');
    const arm = variantOf(union.variants, 'adapter', {
      adapter: 'two',
      name: 'x',
    });
    expect(arm?.tag).toBe('two');
  });

  test('keeps what both arms declare and drops what only the old one did', () => {
    if (union.kind !== 'union') throw new Error('not a union');
    const two = union.variants.find((variant) => variant.tag === 'two');
    if (two === undefined) throw new Error('no second arm');
    const moved = switchVariant(
      { adapter: 'one', name: 'keep me', only: 'drop me' },
      two,
    );
    expect(moved).toEqual({ adapter: 'two', name: 'keep me' });
  });
});
