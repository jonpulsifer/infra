/**
 * The test `src/domain/vessel.ts` says keeps its probe list honest.
 *
 * What this file asserted first was that no adapter appeared under two vessel
 * kinds, because a reverse lookup from a surface to a kind returned the first
 * match and a surface on two kinds made it a silent coin flip. That lookup is
 * gone, and with it the constraint: a boundary carries what a probe finds on
 * it, so the same runtime may be probed for under two kinds without anything
 * becoming ambiguous. Asserting exclusivity now would re-impose by test the
 * rule the model dropped.
 *
 * So the claims here are the ones that survive it: the list is a list of real
 * surfaces, every kind has something to ask about, and the answer to "which
 * surfaces does this vessel carry" is not in this file at all.
 */
import { describe, expect, test } from 'bun:test';
import { targetAdapterSchema } from '../../src/config/manifest.schema.ts';
import * as exports from '../../src/domain/vessel.ts';
import {
  claimsDisagree,
  surfacesToProbe,
  unionOfClaims,
  VESSEL_KINDS,
} from '../../src/domain/vessel.ts';

describe('the surfaces a connect probes for', () => {
  test('every kind has something to ask about', () => {
    // A kind with an empty list is a boundary a connect would register nothing
    // for, silently — the act would succeed and produce no Target and no
    // sentence about why.
    for (const kind of VESSEL_KINDS) {
      expect(surfacesToProbe(kind).length).toBeGreaterThan(0);
    }
  });

  test('every entry is a surface an adapter actually drives', () => {
    // The teeth `satisfies Record<VesselKind, readonly TargetAdapter[]>` gives
    // at compile time, kept at runtime: a probe list naming a runtime nothing
    // implements sends `connectTarget` to an adapter that does not exist.
    for (const kind of VESSEL_KINDS) {
      for (const surface of surfacesToProbe(kind)) {
        expect(targetAdapterSchema.options).toContain(surface);
      }
    }
  });

  test('reads in one direction, and there is no other', () => {
    // The replacement for "no adapter is carried by two kinds". That assertion
    // guarded a reverse lookup, and the reverse lookup is what a project
    // running a cluster would have made a coin flip. Its absence is the claim:
    // this module answers what to ask a kind of boundary and nothing answers
    // which kind of boundary a surface belongs to, so where that answer is
    // needed it comes from the Target rows — see
    // `test/commands/targets.test.ts`, "the surfaces on a vessel are its rows".
    expect(Object.keys(exports).sort()).toEqual([
      'PROBED_SURFACES_BY_VESSEL_KIND',
      'VESSEL_KINDS',
      'claimsDisagree',
      'surfacesToProbe',
      'unionOfClaims',
    ]);
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
