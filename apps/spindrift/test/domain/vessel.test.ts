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
    // An empty list would let a connect succeed and register no Target.
    for (const kind of VESSEL_KINDS) {
      expect(surfacesToProbe(kind).length).toBeGreaterThan(0);
    }
  });

  test('every entry is a surface an adapter actually drives', () => {
    for (const kind of VESSEL_KINDS) {
      for (const surface of surfacesToProbe(kind)) {
        expect(targetAdapterSchema.options).toContain(surface);
      }
    }
  });

  test('reads in one direction, and there is no other', () => {
    // Nothing maps a surface to its vessel kind; the Target rows answer that.
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
    // A failed read must not stop a deploy; the platform still refuses a bad
    // zone, with a better sentence.
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
    for (const kind of VESSEL_KINDS) {
      expect(vesselPrerequisitesFor(kind, ['app'])).toEqual([]);
    }
  });

  test('a cluster is asked nothing even as the home', () => {
    // No code here can read a bucket, store or signing key from a cluster.
    expect(vesselPrerequisitesFor('cluster', ['home'])).toEqual([]);
  });

  test('a boundary in two roles is asked what either role owes, once', () => {
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
    expect(deriveVesselHealth([], 'gcp-project', ['app'])).toBe('healthy');
  });

  test('a checklist that answered fewer rows than it was asked is unhealthy', () => {
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
