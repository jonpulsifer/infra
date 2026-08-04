import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  assertTrustedGatewayBoundary,
  loadManifest,
  MANIFEST_INLINE_VAR,
  MANIFEST_PATH_VAR,
  ManifestError,
  parseManifest,
} from '../../src/config/manifest.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');

const fixtureText = await Bun.file(FIXTURE).text();

describe('the fixture installation', () => {
  test('boots clean from a file', async () => {
    const manifest = await loadManifest({ [MANIFEST_PATH_VAR]: FIXTURE });
    expect(manifest.installation).toBe('example');
    expect(manifest.auth.gateway).toBeNull();
    expect(manifest.dns.zones.private).toBe('apps.example.test');
    expect(manifest.secretStore.adapter).toBe('gcp-secret-manager');
    expect(manifest.targets.map((t) => t.adapter)).toEqual([
      'kubernetes',
      'cloudrun',
      'static',
    ]);
  });

  test('boots clean from an inline document', async () => {
    const manifest = await loadManifest({ [MANIFEST_INLINE_VAR]: fixtureText });
    expect(manifest.installation).toBe('example');
  });

  test('is read from the path when both are set', async () => {
    const manifest = await loadManifest({
      [MANIFEST_PATH_VAR]: FIXTURE,
      [MANIFEST_INLINE_VAR]: 'installation: inline',
    });
    expect(manifest.installation).toBe('example');
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

    expect(() => assertTrustedGatewayBoundary(configured, {})).toThrow(
      'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY',
    );
    expect(() =>
      assertTrustedGatewayBoundary(configured, {
        SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY: 'true',
      }),
    ).not.toThrow();
  });
});

describe('boot fails loudly', () => {
  test('when no manifest is pointed at', async () => {
    await expect(loadManifest({})).rejects.toThrow(ManifestError);
  });

  test('when the file does not exist', async () => {
    await expect(
      loadManifest({
        [MANIFEST_PATH_VAR]: join(import.meta.dir, 'absent.yaml'),
      }),
    ).rejects.toThrow(/no such file/);
  });

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
    expect(message).toContain('cloud');
    expect(message).toContain('charts');
    expect(message).toContain('github');
    expect(message).toContain('secretStore');
    expect(message).toContain('targets');
  });

  test('on a required key that is present but empty', () => {
    const document = fixtureText.replace(
      'installation: example',
      "installation: ''",
    );
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

  test('on duplicate target names', () => {
    const document = fixtureText.replace(
      'name: cloud-cloudrun\n',
      'name: cluster\n',
    );
    expect(() => parseManifest(document, 'test')).toThrow(/unique/);
  });

  test('when a Target names a vessel the document does not declare', () => {
    // What replaced the `<name>-cloudrun` / `<name>-static` pairing rule, and a
    // stronger check than it was: that rule could only say two names looked
    // related, and this one refuses a reference that resolves to nothing —
    // which is what `reconcileManifestTargets` needs, since it looks a vessel
    // up by name and has nothing honest to do without one.
    const document = fixtureText.replace(
      '    vessel: cloud\n    adapter: static',
      '    vessel: hosting\n    adapter: static',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /targets\.2\.vessel: no vessel named hosting is declared/,
    );
  });

  test('when a Target names a vessel whose kind cannot carry its surface', () => {
    // `SURFACES_BY_VESSEL_KIND` is the one statement of which runtimes a
    // boundary carries, and this is where the document is held to it — a
    // `cloudrun` surface on a cluster is refused here rather than reaching an
    // adapter that has no way to place it.
    const document = fixtureText.replace(
      '    vessel: cloud\n    adapter: cloudrun',
      '    vessel: cluster\n    adapter: cloudrun',
    );
    expect(() => parseManifest(document, 'test')).toThrow(
      /a cluster vessel does not carry a cloudrun surface/,
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
 * §15 gives the connected repository the Actions minutes and the billing, so
 * the caller Spindrift writes into somebody's repository runs with that
 * repository's own permissions. A ref that can be moved is therefore a way to
 * run arbitrary steps in every connected repository at once, and the schema is
 * where that is refused rather than warned about.
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
      'an abbreviated sha',
      'example/platform/.github/workflows/build.yml@4bf1f21',
    ],
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
    // Stated the way `auth.gateway` is. A placeholder commit would be a
    // configuration that looks complete and fails at the first build.
    const manifest = parseManifest(
      fixtureText.replace(current ?? '', line('null')),
      'test',
    );
    expect(manifest.github.buildWorkflow).toBeNull();
  });
});
