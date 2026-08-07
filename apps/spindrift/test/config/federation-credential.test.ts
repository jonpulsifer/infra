/**
 * Federation is read from the deployment, not restated in the manifest.
 *
 * The claim under test is the one the ticket is named for: there is exactly one
 * copy of §13's federation facts, it is the `external_account` document the
 * installer chart renders, and no manifest key exists that could disagree with
 * it. So these tests read the *chart's own rendered output* wherever they can —
 * a test that asserted against a hand-written credential would be a second copy
 * of the thing being removed.
 */
import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  FederationCredentialError,
  GCP_CREDENTIALS_VAR,
  loadDeploymentFederation,
  parseFederationCredential,
} from '../../src/config/federation-credential.ts';
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
    // The nullability `cloud.federation` had is preserved and is now
    // structural: a deployment that mounts no credential has none, rather than
    // an operator having remembered to write `null`.
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
    // Silently becoming an installation with no cloud is how a deploy fails for
    // a reason nobody can act on. A broken mount says so.
    await expect(
      loadDeploymentFederation({
        [GCP_CREDENTIALS_VAR]: '/var/run/secrets/spindrift/absent.json',
      }),
    ).rejects.toThrow(FederationCredentialError);
  });

  test('refuses a service account key file wearing the same shape', () => {
    // §13 stores nothing. A key file would parse against every other field, so
    // `type` is the check that keeps the one forbidden credential out.
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
    // Not even a block to hang it off any more: the two keys that used to sit
    // beside it are properties of the home vessel, so `cloud` is derived whole.
    expect(installationManifestSchema.shape).not.toHaveProperty('cloud');
    expect(Object.keys(installationManifestSchema.shape.charts.shape)).toEqual([
      'app',
    ]);
  });

  test('a document that carries one anyway is refused', async () => {
    // The schema is strict, so a document restating what the deployment owns
    // fails to parse rather than being quietly corrected. The installer chart
    // refuses the same two keys at render, which is where an operator meets it.
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
    // And the authored document is untouched by the join, so a write path
    // holding one cannot round-trip a derived value back into the row.
    expect(authored).not.toHaveProperty('cloud');
  });
});
