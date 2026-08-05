/**
 * The test `src/domain/vessel.ts` says keeps its surface table honest.
 *
 * The file cites this one by name — "`satisfies Record<VesselKind, ...>` and
 * the test in `test/domain/vessel.test.ts` between them keep true" — and it did
 * not exist, so half of what guarded `vesselKindFor`'s unreachable throw was a
 * comment. `satisfies` proves every *kind* has an entry; nothing proved every
 * *adapter* appears in one, which is the direction the throw depends on.
 */
import { describe, expect, test } from 'bun:test';
import { targetAdapterSchema } from '../../src/config/manifest.schema.ts';
import {
  claimsDisagree,
  SURFACES_BY_VESSEL_KIND,
  surfacesOf,
  unionOfClaims,
  VESSEL_KINDS,
  vesselKindFor,
} from '../../src/domain/vessel.ts';

describe('every surface is carried by a vessel kind', () => {
  test.each(targetAdapterSchema.options)(
    '%s resolves to the kind whose table lists it',
    (adapter) => {
      const kind = vesselKindFor(adapter);
      expect(surfacesOf(kind)).toContain(adapter);
    },
  );

  test('no adapter is carried by two kinds', () => {
    // The reverse lookup returns the first match, so a surface on two kinds
    // would resolve to whichever `VESSEL_KINDS` happens to list first — a
    // silent coin flip rather than the exhaustive mapping the throw assumes.
    const carriers = targetAdapterSchema.options.map((adapter) =>
      VESSEL_KINDS.filter((kind) =>
        (SURFACES_BY_VESSEL_KIND[kind] as readonly string[]).includes(adapter),
      ),
    );
    expect(carriers.map((kinds) => kinds.length)).toEqual(
      targetAdapterSchema.options.map(() => 1),
    );
  });

  test('every kind carries at least one surface', () => {
    for (const kind of VESSEL_KINDS) {
      expect(surfacesOf(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('reconciling what two surfaces claimed about one boundary', () => {
  test('unions rather than picking a winner, and sorts', () => {
    expect(
      unionOfClaims([['b.test', 'a.test'], ['a.test'], undefined]),
    ).toEqual(['a.test', 'b.test']);
  });

  test('an absent claim is not a claim', () => {
    expect(claimsDisagree([['a.test'], undefined])).toBe(false);
    expect(claimsDisagree([undefined, undefined])).toBe(false);
  });

  test('order is not disagreement, content is', () => {
    expect(
      claimsDisagree([
        ['a.test', 'b.test'],
        ['b.test', 'a.test'],
      ]),
    ).toBe(false);
    expect(claimsDisagree([['a.test'], ['b.test']])).toBe(true);
  });
});
