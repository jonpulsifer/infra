import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  controlPlaneVesselOf,
  homeVesselOf,
  homeVesselProjectOf,
  isDeclaredInstallationVessel,
  sharedServicesOf,
} from '../../src/config/manifest.schema.ts';
import {
  assertTrustedGatewayBoundary,
  ManifestError,
  parseManifest,
  resolveManifest,
} from '../../src/config/manifest.ts';
import { zoneFor } from '../../src/domain/naming.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');

const fixtureText = await Bun.file(FIXTURE).text();

describe('the fixture installation', () => {
  test('parses clean', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    expect(manifest.installation.name).toBe('example');
    expect(manifest.auth.gateway).toBeNull();
    expect(zoneFor('private', manifest.dns.zones)).toBe('apps.example.test');
    expect(manifest.secretStore.adapter).toBe('gcp-secret-manager');
    expect(manifest.targets.map((target) => target.adapter)).toEqual([
      'kubernetes',
      'cloudrun',
      'static',
    ]);
  });
});

describe('the authenticated Gateway trust boundary', () => {
  test('fails closed when header authentication has no deployment attestation', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    const configured = {
      ...manifest,
      auth: {
        gateway: {
          adapterKey: 'front-door',
          issuer: 'https://issuer.example.test',
          subjectHeader: 'x-auth-request-subject',
        },
      },
    };

    expect(() =>
      assertTrustedGatewayBoundary({
        ...configured,
        boundary: { trustedGateway: false },
      }),
    ).toThrow('SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY');
    expect(() =>
      assertTrustedGatewayBoundary({
        ...configured,
        boundary: { trustedGateway: true },
      }),
    ).not.toThrow();

    // The attestation comes from the environment, so no manifest write can set
    // it.
    expect(
      (
        await resolveManifest(manifest, {
          SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY: 'true',
        })
      ).boundary,
    ).toEqual({ trustedGateway: true });
    expect((await resolveManifest(manifest, {})).boundary).toEqual({
      trustedGateway: false,
    });
  });

  test('the running version is a deployment fact, and unset is null', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    // From the environment, so no manifest write can set it.
    expect(
      (await resolveManifest(manifest, { SPINDRIFT_VERSION: ' 1.2.3 ' }))
        .controlPlane.version,
    ).toBe('1.2.3');
    expect(
      (await resolveManifest(manifest, {})).controlPlane.version,
    ).toBeNull();
  });

  test('the public hostname is a deployment fact, lowercased, and unset is null', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    expect(
      (
        await resolveManifest(manifest, {
          SPINDRIFT_PUBLIC_HOSTNAME: ' Spindrift-Control.Example.Test ',
        })
      ).controlPlane.publicHostname,
    ).toBe('spindrift-control.example.test');
    expect(
      (await resolveManifest(manifest, {})).controlPlane.publicHostname,
    ).toBeNull();
  });

  test('reserved hostnames are a comma-separated deployment fact, and unset is none', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    expect(
      (
        await resolveManifest(manifest, {
          SPINDRIFT_RESERVED_HOSTNAMES:
            ' Kthx.Example.Test, ,other.example.test',
        })
      ).controlPlane.reservedHostnames,
    ).toEqual(['kthx.example.test', 'other.example.test']);
    expect(
      (await resolveManifest(manifest, {})).controlPlane.reservedHostnames,
    ).toEqual([]);
  });
});

describe('boot fails loudly', () => {
  test('when the document is not YAML', () => {
    expect(() => parseManifest('installation: [unclosed', 'test')).toThrow(
      ManifestError,
    );
  });

  test('naming every missing key at once', () => {
    let message = '';
    try {
      parseManifest('installation: example\n', 'test');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('dns');
    expect(message).toContain('auth');
    expect(message).toContain('vessels');
    expect(message).toContain('charts');
    expect(message).toContain('github');
    expect(message).toContain('secretStore');
    expect(message).toContain('targets');
  });

  test('on a required key that is present but empty', () => {
    const document = fixtureText.replace('name: example', "name: ''");
    expect(() => parseManifest(document, 'test')).toThrow(/installation/);
  });

  test('on an unknown key, which is a typo or a stale manifest', () => {
    expect(() =>
      parseManifest(`${fixtureText}\nvessel: mistake\n`, 'test'),
    ).toThrow(/vessel/);
  });

  test('on an unknown target adapter', () => {
    const document = fixtureText.replace(
      'adapter: kubernetes',
      'adapter: nomad',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /targets\.0\.adapter/,
    );
  });

  test('on a Target that repeats another’s vessel and adapter', () => {
    // `(vessel, adapter)` identifies a Target.
    const document = fixtureText.replace(
      '  - vessel: cloud\n    adapter: static',
      '  - vessel: cluster\n    adapter: kubernetes',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /a vessel carries one surface of each kind/,
    );
  });

  test('when a Target names a vessel the document does not declare', () => {
    // `reconcileManifestTargets` looks vessels up by name, so the reference
    // must resolve.
    const document = fixtureText.replace(
      '  - vessel: cloud\n    adapter: static',
      '  - vessel: hosting\n    adapter: static',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /targets\.2\.vessel: no vessel named hosting is declared/,
    );
  });

  test('on duplicate vessel names', () => {
    const document = fixtureText.replace(
      '  - name: cloud\n',
      '  - name: cluster\n',
    );
    expect(() => parseManifest(document, 'test')).toThrow(/unique/);
  });

  test('with no targets at all', () => {
    const document = fixtureText.split('targets:')[0] ?? '';
    expect(() => parseManifest(`${document}targets: []\n`, 'test')).toThrow(
      /targets/,
    );
  });
});

/**
 * A vessel's `kind` shapes its location. Its surfaces come from `targets` and
 * the connect probe.
 */
describe('a vessel’s kind is not a list of the runtimes on it', () => {
  test('a document may declare a surface no table pairs with that kind', () => {
    const document = fixtureText.replace(
      '  - vessel: cloud\n    adapter: cloudrun',
      '  - vessel: cluster\n    adapter: cloudrun',
    );
    expect(() => parseManifest(document, 'test')).not.toThrow();
  });

  test('and the reference itself is still checked', () => {
    const document = fixtureText.replace(
      '  - vessel: cloud\n    adapter: cloudrun',
      '  - vessel: nowhere\n    adapter: cloudrun',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /no vessel named nowhere is declared/,
    );
  });
});

/**
 * The caller workflow runs with the connected repository's permissions. A sha
 * ref freezes the reusable workflow, and a branch follows its merge gate.
 */
describe('the reusable build workflow ref', () => {
  const line = (value: string) => `  buildWorkflow: ${value}`;
  const current = fixtureText
    .split('\n')
    .find((row) => row.trim().startsWith('buildWorkflow:'));

  test.each([
    ['a branch', 'example/platform/.github/workflows/build.yml@main'],
    ['a tag', 'example/platform/.github/workflows/build.yml@v1.2.3'],
    [
      'a full sha',
      `example/platform/.github/workflows/build.yml@${'0'.repeat(40)}`,
    ],
  ] as const)('accepts %s', (_name, ref) => {
    const manifest = parseManifest(
      fixtureText.replace(current ?? '', line(ref)),
      'test',
    );
    expect(manifest.github.buildWorkflow).toBe(ref);
  });

  test.each([
    ['no ref at all', 'example/platform/.github/workflows/build.yml'],
    [
      'a path that is not a workflow',
      `example/platform/build.yml@${'0'.repeat(40)}`,
    ],
  ] as const)('refuses %s', (_name, ref) => {
    expect(() =>
      parseManifest(fixtureText.replace(current ?? '', line(ref)), 'test'),
    ).toThrow(/buildWorkflow/);
  });

  test('accepts null, which is an installation that has published none', () => {
    // A placeholder ref would look complete and fail at the first build.
    const manifest = parseManifest(
      fixtureText.replace(current ?? '', line('null')),
      'test',
    );
    expect(manifest.github.buildWorkflow).toBeNull();
  });
});

/** `controlPlaneVessel` and `homeVessel` must each name a declared vessel. */
describe('the vessels this installation is built on', () => {
  const fixture = Bun.YAML.parse(fixtureText) as Record<string, unknown>;

  function withInstallation(
    installation: Record<string, unknown>,
    vessels: unknown = fixture.vessels,
  ) {
    return JSON.stringify({ ...fixture, installation, vessels });
  }

  test('a pointer naming nothing declared is refused, by path', () => {
    expect(() =>
      parseManifest(
        withInstallation({
          name: 'example',
          controlPlaneVessel: 'nowhere',
          homeVessel: 'cloud',
        }),
        'test',
      ),
    ).toThrow(/installation.controlPlaneVessel: no vessel named nowhere/);
  });

  test('the home vessel must declare the shared services', () => {
    // `cluster` declares no `shared`.
    expect(() =>
      parseManifest(
        withInstallation({
          name: 'example',
          controlPlaneVessel: 'cluster',
          homeVessel: 'cluster',
        }),
        'test',
      ),
    ).toThrow(/must declare its shared services/);
  });

  test('no other vessel may declare them', () => {
    // Two vessels with `shared` would give two answers.
    const vessels = (fixture.vessels as Record<string, unknown>[]).map(
      (vessel) => ({
        ...vessel,
        shared: {
          sourceBucket: 'a-bucket',
          artifactsProject: 'a-project',
          secretStoreContainer: 'a-container',
        },
      }),
    );
    expect(() =>
      parseManifest(
        withInstallation(
          fixture.installation as Record<string, unknown>,
          vessels,
        ),
        'test',
      ),
    ).toThrow(/may declare shared services/);
  });

  test('what a reader gets is the home vessel’s, resolved once', async () => {
    const manifest = parseManifest(fixtureText, FIXTURE);
    expect(homeVesselOf(manifest).name).toBe('cloud');
    expect(controlPlaneVesselOf(manifest).name).toBe('cluster');
    expect(sharedServicesOf(manifest)).toEqual({
      sourceBucket: 'example-source-bucket',
      artifactsProject: 'example-artifacts',
      secretStoreContainer: 'example-secrets',
    });
    // The fixture declares no vessel locations, so there is no project to read.
    expect(homeVesselProjectOf(manifest)).toBeNull();
    expect(isDeclaredInstallationVessel(manifest, 'cloud')).toBe(true);
    expect(isDeclaredInstallationVessel(manifest, 'somewhere-else')).toBe(
      false,
    );
  });
});
