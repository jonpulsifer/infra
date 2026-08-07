/**
 * The change that clears an unmet row, generated.
 *
 * Two claims are asserted over and over here, because they are the two ways a
 * generated change stops being worth having:
 *
 * 1. **It names what was observed and nothing else.** The service the probe
 *    found switched off, the project it named, the bucket this installation
 *    stages into. A stanza carrying the full set of services, or a member
 *    somebody has to correct, reads as finished and is not. The half that is
 *    easy to lose is that an unmet row is not itself an observation: both
 *    checklists report a row unmet when they could not assess it, and a change
 *    generated from one of those names a fault nobody saw.
 * 2. **It never invents where it goes.** A boundary with a declared root gets a
 *    path inside it; a boundary with none gets the honest statement, and the
 *    act that would open a pull request refuses rather than creating a root.
 *
 * And the third, which is most of the catalogue: a row cleared by something
 * other than Terraform says so with a reason, so the screen renders a sentence
 * rather than an empty box.
 */
import { describe, expect, test } from 'bun:test';
import { PREREQUISITES } from '../../src/domain/capabilities.ts';
import {
  type RemediationSubject,
  remediationFor,
} from '../../src/domain/remediation.ts';
import { VESSEL_PREREQUISITES } from '../../src/domain/vessel.ts';

const HOME: RemediationSubject = {
  vessel: 'cloud',
  project: 'example-vessel',
  terraformRoot: 'terraform/projects/cloud',
  adapter: 'cloudrun',
  principal: 'serviceAccount:spindrift@example.test',
  region: 'example-region',
  sourceBucket: 'example-source-bucket',
};

/** The `kind: 'generated'` arm, or a failure naming what came back instead. */
function generated(remediation: ReturnType<typeof remediationFor>) {
  if (remediation.kind !== 'generated') {
    throw new Error(`expected a stanza, got: ${remediation.reason}`);
  }
  return remediation;
}

describe('a service the probe found switched off', () => {
  test('the stanza enables that service and no other', () => {
    const change = generated(remediationFor({ name: 'PLATFORM_API' }, HOME));
    expect(change.terraform).toContain('google_project_service');
    expect(change.terraform).toContain('"run.googleapis.com"');
    expect(change.terraform).toContain('"example-vessel"');
    // Never the full set: the probe established one service was off, and
    // enabling the rest of a project's APIs is a change nobody asked to review.
    expect(change.terraform).not.toContain('firebasehosting');
    expect(change.terraform).not.toContain('for_each');
  });

  test('the surface decides the service', () => {
    const change = generated(
      remediationFor({ name: 'PLATFORM_API' }, { ...HOME, adapter: 'static' }),
    );
    expect(change.terraform).toContain('"firebasehosting.googleapis.com"');
    expect(change.terraform).not.toContain('run.googleapis.com');
  });

  test('it belongs in the root the boundary declares', () => {
    const change = generated(remediationFor({ name: 'PLATFORM_API' }, HOME));
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/services.tf',
    });
  });

  test('a boundary with no root gets the statement, never a path', () => {
    const change = generated(
      remediationFor(
        { name: 'PLATFORM_API' },
        { ...HOME, terraformRoot: null },
      ),
    );
    expect(change.destination).toEqual({
      kind: 'absent',
      vessel: 'cloud',
      file: 'services.tf',
    });
    // The stanza still stands: "here is what a root would contain" is an answer
    // an operator can act on. What is withheld is the location.
    expect(change.terraform).toContain('google_project_service');
  });

  test('a surface with no service of its own generates nothing', () => {
    // `PLATFORM_API` is never asked of a cluster, and answering it with a cloud
    // service name would be this generator inventing what the probe checked.
    const change = remediationFor(
      { name: 'PLATFORM_API' },
      {
        ...HOME,
        adapter: 'kubernetes',
      },
    );
    expect(change.kind).toBe('none');
  });
});

describe('an identity the boundary refused', () => {
  test('the grant names the principal this deployment actually federates as', () => {
    const change = generated(remediationFor({ name: 'OIDC_FEDERATION' }, HOME));
    expect(change.terraform).toContain('google_project_iam_member');
    expect(change.terraform).toContain('"roles/run.admin"');
    expect(change.terraform).toContain(
      '"serviceAccount:spindrift@example.test"',
    );
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/iam.tf',
    });
  });

  test('with no principal observed there is no stanza, and it says why', () => {
    // The one place a placeholder would be tempting. A member somebody has to
    // replace before merging is a pull request that looks reviewed and is not.
    const change = remediationFor(
      { name: 'OIDC_FEDERATION' },
      {
        ...HOME,
        principal: null,
      },
    );
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('attribute mapping');
  });
});

describe('the bucket a build stages into', () => {
  test('the stanza declares it where a connected surface says', () => {
    const change = generated(remediationFor({ name: 'SOURCE_BUCKET' }, HOME));
    expect(change.terraform).toContain('google_storage_bucket');
    expect(change.terraform).toContain('"example-source-bucket"');
    expect(change.terraform).toContain('"example-region"');
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/storage.tf',
    });
  });

  test('with no location observed there is no stanza', () => {
    // A bucket's location cannot be changed afterwards, so guessing one is the
    // single most expensive thing this generator could get wrong.
    const change = remediationFor(
      { name: 'SOURCE_BUCKET' },
      { ...HOME, region: null },
    );
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('location');
  });
});

describe('a row the probe never got far enough to assess', () => {
  test('the change is withheld even where the name has a generator', () => {
    // The single most common first-connect state: a project with the Run API
    // switched off. `cloud/checklist.ts` reports `PLATFORM_API` unmet because
    // it observed that, and `OIDC_FEDERATION` unmet because the one probe that
    // would have answered it never got past the disabled service. Generating a
    // grant from the second is proposing a privilege for a call nobody made.
    const change = remediationFor(
      { name: 'OIDC_FEDERATION', assessed: false },
      HOME,
    );
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('nothing here observed');
  });

  test('a refused listing does not become a bucket that was never missing', () => {
    // `holds` marks a row unmet when the listing came back `unavailable` — a
    // refused `storage.buckets.list` reads exactly like this, and the bucket it
    // could not see is usually declared and applied already.
    const change = remediationFor(
      { name: 'SOURCE_BUCKET', assessed: false },
      HOME,
    );
    expect(change.kind).toBe('none');
  });

  test('every generated name is withheld the same way', () => {
    for (const name of [
      'PLATFORM_API',
      'OIDC_FEDERATION',
      'SOURCE_BUCKET',
    ] as const) {
      expect(remediationFor({ name, assessed: false }, HOME).kind).toBe('none');
      // And the same row, assessed, is the one that does get a stanza — so this
      // asserts the gate rather than a generator that was never going to fire.
      expect(remediationFor({ name, assessed: true }, HOME).kind).toBe(
        'generated',
      );
    }
  });
});

describe('what a stanza says it already owns', () => {
  test('each one names its resource address and the value it manages', () => {
    // Read by the pull request path against the destination file. The address
    // catches a root that declares the same resource — which
    // `terraform/gcp/projects/bluenose/storage.tf` does, byte for byte — and
    // the value catches a root that owns the same fact under a `for_each` this
    // generator cannot predict a label for.
    const api = generated(remediationFor({ name: 'PLATFORM_API' }, HOME));
    expect(api.declares).toContain('"google_project_service" "spindrift_run"');
    expect(api.declares).toContain('"run.googleapis.com"');

    const grant = generated(remediationFor({ name: 'OIDC_FEDERATION' }, HOME));
    expect(grant.declares).toContain('"roles/run.admin"');

    const bucket = generated(remediationFor({ name: 'SOURCE_BUCKET' }, HOME));
    expect(bucket.declares).toContain(
      '"google_storage_bucket" "spindrift_source"',
    );
    expect(bucket.declares).toContain('"example-source-bucket"');
  });

  test('every fact it names is one the stanza itself contains', () => {
    // Otherwise the check reads for something that was never written, and a
    // file is refused — or admitted — over a string nothing here emits.
    for (const name of [
      'PLATFORM_API',
      'OIDC_FEDERATION',
      'SOURCE_BUCKET',
    ] as const) {
      const change = generated(remediationFor({ name }, HOME));
      for (const fact of change.declares) {
        expect(change.terraform).toContain(fact);
      }
    }
  });
});

describe('the rows Terraform does not clear', () => {
  test('every one of them answers with a reason rather than nothing', () => {
    // Total over both catalogues: an unmet row an operator can see always has
    // an answer here, so the screen never has to decide what an absent
    // remediation meant.
    for (const name of [...PREREQUISITES, ...VESSEL_PREREQUISITES]) {
      const change = remediationFor({ name }, HOME);
      if (change.kind === 'none') {
        expect(change.reason.length).toBeGreaterThan(0);
      } else {
        expect(change.terraform.length).toBeGreaterThan(0);
      }
    }
  });

  test('the boundary itself is never generated', () => {
    // §14: Spindrift never creates a vessel — and never writes the change that
    // would, which is the same rule one step out.
    const change = remediationFor({ name: 'VESSEL' }, HOME);
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('never creates a vessel');
  });

  test('the cluster-side rows point at the tree that owns them', () => {
    for (const name of ['DELIVERY_OPERATOR', 'CHART_SOURCE'] as const) {
      const change = remediationFor({ name }, HOME);
      expect(change.kind).toBe('none');
      if (change.kind !== 'none') continue;
      expect(change.reason).toContain('Terraform');
      expect(change.reason).toContain('cluster');
    }
  });
});
