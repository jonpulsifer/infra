/**
 * Federation comes from the deployment's mounted `external_account` credential,
 * and the manifest has no key that could restate it.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  FederationCredentialError,
  GCP_CREDENTIALS_VAR,
  loadDeploymentFederation,
  parseFederationCredential,
} from '@repo/archive/federation-credential';
import { installationManifestSchema } from '../../src/config/manifest.schema.ts';
import { parseManifest, resolveManifest } from '../../src/config/manifest.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');
const CREDENTIAL = join(import.meta.dir, '../fixtures/gcp-credentials.json');

describe('the credential the deployment mounts', () => {
  test('is the whole of the federation, field for field', async () => {
    const federation = await loadDeploymentFederation({
      [GCP_CREDENTIALS_VAR]: CREDENTIAL,
    });

    expect(federation).toEqual({
      audience:
        '//iam.example.test/projects/1/locations/global/workloadIdentityPools/example/providers/cluster',
      tokenUrl: 'https://sts.example.test/v1/token',
      tokenPath: '/var/run/secrets/cloud/token',
      impersonationUrl:
        'https://iamcredentials.example.test/v1/projects/-/serviceAccounts/spindrift@example-home.example.test:generateAccessToken',
    });
  });

  test('leaves an installation with no cloud Targets honestly null', async () => {
    expect(await loadDeploymentFederation({})).toBeNull();
  });

  test('impersonation is optional, because direct grants are a real posture', () => {
    const direct = parseFederationCredential(
      JSON.stringify({
        type: 'external_account',
        audience: '//iam.example.test/pools/direct',
        token_url: 'https://sts.example.test/v1/token',
        credential_source: { file: '/var/run/secrets/cloud/token' },
      }),
      'direct',
    );
    expect(direct.impersonationUrl).toBeNull();
  });

  test('a named credential that is not mounted is an error, not an absence', async () => {
    // A broken mount fails loudly, never reading as an installation with no
    // cloud.
    await expect(
      loadDeploymentFederation({
        [GCP_CREDENTIALS_VAR]: '/var/run/secrets/spindrift/absent.json',
      }),
    ).rejects.toThrow(FederationCredentialError);
  });

  test('refuses a service account key file wearing the same shape', () => {
    // A key file matches every other field, so `type` is what refuses it.
    expect(() =>
      parseFederationCredential(
        JSON.stringify({
          type: 'service_account',
          audience: '//iam.example.test/pools/wrong',
          token_url: 'https://sts.example.test/v1/token',
          credential_source: { file: '/var/run/secrets/cloud/token' },
          private_key: '-----BEGIN PRIVATE KEY-----',
        }),
        'a key file',
      ),
    ).toThrow(FederationCredentialError);
  });

  test('refuses a relative token path', () => {
    expect(() =>
      parseFederationCredential(
        JSON.stringify({
          type: 'external_account',
          audience: '//iam.example.test/pools/relative',
          token_url: 'https://sts.example.test/v1/token',
          credential_source: { file: 'gcp-token' },
        }),
        'a relative path',
      ),
    ).toThrow(/absolute path/);
  });
});

describe('the manifest cannot restate it', () => {
  test('there is no key to write it into', () => {
    // `cloud` comes only from the deployment.
    expect(installationManifestSchema.shape).not.toHaveProperty('cloud');
    expect(Object.keys(installationManifestSchema.shape.charts.shape)).toEqual([
      'app',
    ]);
  });

  test('a document that carries one anyway is refused', async () => {
    // The schema is strict, so a restated key fails to parse.
    const document = Bun.YAML.parse(await Bun.file(FIXTURE).text()) as Record<
      string,
      unknown
    >;
    const restated = {
      ...document,
      cloud: {
        federation: {
          audience: '//iam.stale.test/pools/stale',
          tokenUrl: 'https://sts.stale.test/v1/token',
          tokenPath: '/var/run/secrets/stale/token',
          impersonationUrl: null,
        },
      },
      charts: {
        ...(document.charts as Record<string, unknown>),
        installer: 'example/spindrift',
      },
    };

    expect(() =>
      parseManifest(JSON.stringify(restated), 'a stale document'),
    ).toThrow(/cloud/);
  });

  test('what readers get is the deployment’s copy, joined on at resolve', async () => {
    const authored = parseManifest(await Bun.file(FIXTURE).text(), FIXTURE);
    const resolved = await resolveManifest(authored, {
      [GCP_CREDENTIALS_VAR]: CREDENTIAL,
    });

    expect(resolved.cloud.federation?.tokenPath).toBe(
      '/var/run/secrets/cloud/token',
    );
    // The join leaves the authored document alone, so no write path stores a
    // derived value.
    expect(authored).not.toHaveProperty('cloud');
  });
});
