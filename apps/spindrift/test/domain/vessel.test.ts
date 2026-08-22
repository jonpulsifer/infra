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
  deriveVesselHealth,
  servableZone,
  surfacesToProbe,
  unionOfClaims,
  unreachableVesselPrerequisites,
  VESSEL_KINDS,
  VESSEL_PREREQUISITES,
  VESSEL_ROLES,
  vesselPrerequisitesFor,
  vesselRolesOf,
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
      'DATASTORE_SURFACE_BY_VESSEL_KIND',
      'PROBED_SURFACES_BY_VESSEL_KIND',
      'VESSEL_KINDS',
      'VESSEL_PREREQUISITES',
      'VESSEL_PREREQUISITES_BY_KIND_AND_ROLE',
      'VESSEL_ROLES',
      'claimsDisagree',
      'deriveVesselHealth',
      'servableZone',
      'surfacesToProbe',
      'unionOfClaims',
      'unreachableVesselPrerequisites',
      'vesselPrerequisitesFor',
      'vesselRolesOf',
    ]);
  });
});

describe('which declared zone an account can serve', () => {
  test('the first declared zone the account actually carries', () => {
    // Not the head of the declared list: `private.test` is this installation's
    // first zone and is served somewhere else entirely.
    expect(
      servableZone(
        ['private.test', 'public.test'],
        [
          { name: 'public.test', id: 'zone-1', status: 'active' },
          { name: 'spare.test', id: 'zone-2', status: 'active' },
        ],
      ),
    ).toBe('public.test');
  });

  test('nothing carried is nothing to serve, not the head', () => {
    expect(servableZone(['private.test'], [])).toBeNull();
  });

  test('a read that established nothing falls back to the head', () => {
    // A probe that could not run must not be the reason a deploy stops: the
    // platform's own refusal is still there, with a better sentence.
    expect(servableZone(['private.test', 'public.test'], null)).toBe(
      'private.test',
    );
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

/**
 * The catalogue's second axis.
 *
 * `PREREQUISITES_BY_ADAPTER` keys off adapter because "a checklist row that can
 * never fail is a row that teaches a reader the wrong thing about what was
 * checked". These are the same claim one axis over: what the installation asks
 * of a boundary depends on what that boundary is *to it*, not only on what it is
 * made of, and an app vessel is asked nothing.
 */
describe('what a vessel is asked, by kind and by role', () => {
  test('the home cloud vessel carries the four the installation depends on', () => {
    expect(vesselPrerequisitesFor('gcp-project', ['home'])).toEqual([
      'SOURCE_BUCKET',
      'SECRET_STORE',
      'SIGNER_KEY',
      'ARTIFACTS_PROJECT',
    ]);
  });

  test('an app vessel is asked nothing, whatever its kind', () => {
    // The point of the axis: four permanently green rows on an ordinary deploy
    // boundary would say those were checked when nothing looked at them.
    for (const kind of VESSEL_KINDS) {
      expect(vesselPrerequisitesFor(kind, ['app'])).toEqual([]);
    }
  });

  test('a cluster is asked nothing even as the home', () => {
    // Honest rather than aspirational: a source bucket, a store container and a
    // signing key are reads no code here knows how to make against a cluster.
    expect(vesselPrerequisitesFor('cluster', ['home'])).toEqual([]);
  });

  test('a boundary in two roles is asked what either role owes, once', () => {
    // An installation whose control plane runs where its shared services live
    // is one boundary doing two jobs. A scalar role would have to pick one.
    expect(
      vesselPrerequisitesFor('gcp-project', ['home', 'controlPlane']),
    ).toEqual([...VESSEL_PREREQUISITES]);
  });

  test('every catalogued row is a prerequisite this module has a name for', () => {
    for (const kind of VESSEL_KINDS) {
      for (const role of VESSEL_ROLES) {
        for (const name of vesselPrerequisitesFor(kind, [role])) {
          expect(VESSEL_PREREQUISITES).toContain(name);
        }
      }
    }
  });

  test('a vessel neither pointer names is an app vessel', () => {
    const manifest = {
      installation: {
        name: 'a-test',
        controlPlaneVessel: 'here',
        homeVessel: 'home',
      },
    };
    expect(vesselRolesOf(manifest, 'home')).toEqual(['home']);
    expect(vesselRolesOf(manifest, 'here')).toEqual(['controlPlane']);
    expect(vesselRolesOf(manifest, 'elsewhere')).toEqual(['app']);
    expect(
      vesselRolesOf(
        { installation: { ...manifest.installation, homeVessel: 'here' } },
        'here',
      ),
    ).toEqual(['home', 'controlPlane']);
  });
});

describe('a vessel’s health is every catalogued row met', () => {
  test('an unreachable pass answers every row unmet, never no rows', () => {
    const unmet = unreachableVesselPrerequisites(
      'nobody could look',
      'gcp-project',
      ['home'],
    );
    expect(unmet.map((item) => item.name)).toEqual([...VESSEL_PREREQUISITES]);
    expect(unmet.every((item) => !item.met && item.detail)).toBe(true);
    expect(deriveVesselHealth(unmet, 'gcp-project', ['home'])).toBe(
      'unhealthy',
    );
  });

  test('an app vessel is healthy because nothing about it can be broken here', () => {
    // Vacuously, and that is the right answer rather than a loophole: it holds
    // nothing this installation depends on. Its Targets fail on their own terms.
    expect(deriveVesselHealth([], 'gcp-project', ['app'])).toBe('healthy');
  });

  test('a checklist that answered fewer rows than it was asked is unhealthy', () => {
    // The same rule `deriveHealth` applies to a Target: a pass that silently
    // stopped reporting a row must not make a boundary look healthier.
    expect(
      deriveVesselHealth(
        [
          { name: 'SOURCE_BUCKET', met: true },
          { name: 'SECRET_STORE', met: true },
        ],
        'gcp-project',
        ['home'],
      ),
    ).toBe('unhealthy');
  });
});
