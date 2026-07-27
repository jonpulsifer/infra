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
    expect(manifest.dns.apexZone).toBe('apps.example.test');
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
    const document = fixtureText.replace('name: cloud\n', 'name: cluster\n');
    expect(() => parseManifest(document, 'test')).toThrow(/unique/);
  });

  test('with no targets at all', () => {
    const document = fixtureText.split('targets:')[0] ?? '';
    expect(() => parseManifest(`${document}targets: []\n`, 'test')).toThrow(
      /targets/,
    );
  });
});
