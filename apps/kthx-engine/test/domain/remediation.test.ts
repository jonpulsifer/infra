import { describe, expect, test } from 'bun:test';
import { cloudChecklist } from '../../src/adapters/deploy/cloud/checklist.ts';
import type { CloudResponse } from '../../src/adapters/deploy/cloud/http.ts';
import {
  remediationSubject,
  withRemediations,
} from '../../src/commands/targets/remediation.ts';
import type { InstallationManifest } from '../../src/config/manifest.ts';
import { PREREQUISITES } from '../../src/domain/capabilities.ts';
import {
  type RemediationSubject,
  remediationFor,
} from '../../src/domain/remediation.ts';
import { VESSEL_PREREQUISITES } from '../../src/domain/vessel.ts';
import { fixtureManifest } from '../harness/installation.ts';

const DECLARED = [
  {
    name: 'cloud',
    project: 'example-vessel',
    terraformRoot: 'terraform/projects/cloud',
  },
] as const;

const HOME: RemediationSubject = {
  vessel: 'cloud',
  project: 'example-vessel',
  terraformRoot: 'terraform/projects/cloud',
  adapter: 'cloudrun',
  principal: 'serviceAccount:spindrift@example.test',
  region: 'example-region',
  sourceBucket: 'example-source-bucket',
  declared: DECLARED,
};

/** Another boundary, whose calls still bill the home vessel's project. */
const ELSEWHERE: RemediationSubject = {
  ...HOME,
  vessel: 'elsewhere',
  project: 'other-vessel',
  terraformRoot: null,
  sourceBucket: null,
};

/** The fixture with a home project, which the consumer lookup needs. */
const declaring: InstallationManifest = ((manifest: InstallationManifest) => ({
  ...manifest,
  vessels: manifest.vessels.map((vessel) =>
    vessel.name === manifest.installation.homeVessel &&
    vessel.kind === 'gcp-project'
      ? { ...vessel, location: { project: 'example-vessel' } }
      : vessel,
  ),
}))(await fixtureManifest());

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
    expect(change.terraform).toContain('google_project_service');
  });

  test('the switch that is off is the consumer’s, so the stanza is too', () => {
    // GCP refuses a call when its consumer project has the service off,
    // whatever project the URL names.
    const change = generated(
      remediationFor(
        { name: 'PLATFORM_API', consumer: 'example-vessel' },
        ELSEWHERE,
      ),
    );
    expect(change.terraform).toContain('"example-vessel"');
    expect(change.terraform).not.toContain('other-vessel');
    expect(change.summary).toContain('not other-vessel');
  });

  test('and it goes to the root the consumer’s boundary declares', () => {
    const change = generated(
      remediationFor(
        { name: 'PLATFORM_API', consumer: 'example-vessel' },
        ELSEWHERE,
      ),
    );
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/services.tf',
    });
  });

  test('a consumer no declaration names gets the reason, never a guess', () => {
    const change = remediationFor(
      { name: 'PLATFORM_API', consumer: 'somebody-elses-project' },
      ELSEWHERE,
    );
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('somebody-elses-project');
    expect(change.reason).toContain('no root');
  });

  test('a consumer that is the probed project changes nothing', () => {
    const change = generated(
      remediationFor(
        { name: 'PLATFORM_API', consumer: 'example-vessel' },
        HOME,
      ),
    );
    expect(change.terraform).toContain('"example-vessel"');
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/services.tf',
    });
    expect(change.summary).not.toContain('bill');
  });

  test('a surface with no service of its own generates nothing', () => {
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
    // A bucket's location cannot change after it is created.
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
    // With the Run API off, OIDC_FEDERATION is unmet only because its probe
    // never got past the disabled service.
    const change = remediationFor(
      { name: 'OIDC_FEDERATION', assessed: false },
      HOME,
    );
    expect(change.kind).toBe('none');
    if (change.kind !== 'none') return;
    expect(change.reason).toContain('nothing here observed');
  });

  test('a refused listing does not become a bucket that was never missing', () => {
    // A refused bucket listing leaves the row unmet without seeing the bucket.
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
      // Assessed, the same row generates, so the gate is what withholds it.
      expect(remediationFor({ name, assessed: true }, HOME).kind).toBe(
        'generated',
      );
    }
  });
});

describe('what a stanza says it already owns', () => {
  test('each one names its resource address and the value it manages', () => {
    // The pull request path checks these against the destination file: the
    // address finds the same resource, the value finds it under a for_each.
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
      // An Argo Target's chart source is a repository recorded on the Target.
      if (name === 'CHART_SOURCE') expect(change.reason).toContain('Target');
    }
  });
});

// Runs from the checklist's refusal, through the stored row, to the generated
// stanza, since a fact can survive one hop and be lost at the next.
describe('a refusal about the project the calls bill to', () => {
  /** Cloud Run's answer when the caller's project has the API off. */
  const REFUSED: CloudResponse<unknown> = {
    ok: false,
    kind: 'status',
    status: 403,
    body: JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }),
    reason: 'SERVICE_DISABLED',
    consumer: 'example-vessel',
    message:
      'Cloud Run Admin API has not been used in project example-vessel before or it is disabled',
  };

  test('the stanza names that project, and lands in its root', () => {
    const rows = cloudChecklist(REFUSED, {
      project: 'other-vessel',
      service: 'Cloud Run',
      scope: 'services in other-vessel',
    });
    const answered = withRemediations(
      rows,
      remediationSubject(
        declaring,
        {
          name: 'elsewhere',
          location: { kind: 'gcp-project', project: 'other-vessel' },
          surfaces: [
            { connection: { adapter: 'cloudrun', region: 'example-region' } },
          ],
        },
        'cloudrun',
      ),
    );

    const change = generated(
      answered.find((row) => row.name === 'PLATFORM_API')?.remediation ?? {
        kind: 'none',
        reason: 'PLATFORM_API is not on the checklist this refusal produced',
      },
    );
    expect(change.terraform).toContain('"example-vessel"');
    expect(change.terraform).toContain('"run.googleapis.com"');
    expect(change.terraform).not.toContain('other-vessel');
    expect(change.destination).toEqual({
      kind: 'root',
      path: 'terraform/projects/cloud/services.tf',
    });
  });

  test('a refusal naming no consumer still answers about the probed project', () => {
    const rows = cloudChecklist(
      { ...REFUSED, consumer: null },
      {
        project: 'example-vessel',
        service: 'Cloud Run',
        scope: 'services in example-vessel',
      },
    );
    const platform = rows.find((row) => row.name === 'PLATFORM_API');
    expect(platform?.consumer).toBeUndefined();
    expect(platform?.detail).toContain('example-vessel');
    expect(platform?.detail).not.toContain('bill');
  });
});
