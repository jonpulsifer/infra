/** Application Default Credentials: the files the CLI reads, and the tokens it mints. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base64urlEncode } from '@repo/archive/bytes';
import { ID_AUDIENCE, loadCredentials } from '../cli/adc.ts';

const ACCOUNT = 'kthx-deployer@bluenose.iam.gserviceaccount.com';

const seen: { path: string; authorization: string | null; body: string }[] = [];

const jwt = (claims: Record<string, unknown>) => {
  const part = (value: unknown) =>
    base64urlEncode(new TextEncoder().encode(JSON.stringify(value)));
  return `${part({ alg: 'RS256' })}.${part(claims)}.sig`;
};

const google = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    seen.push({
      path: url.pathname,
      authorization: request.headers.get('authorization'),
      body,
    });
    if (url.pathname === '/sts') {
      return Response.json({ access_token: 'federated', expires_in: 3600 });
    }
    if (url.pathname.endsWith(':generateAccessToken')) {
      return Response.json({
        accessToken: 'impersonated',
        expireTime: new Date(Date.now() + 3600_000).toISOString(),
      });
    }
    if (url.pathname.endsWith(':generateIdToken')) {
      return Response.json({
        token: jwt({
          email: ACCOUNT,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      });
    }
    if (url.pathname === '/token') {
      return Response.json({ access_token: 'user-access', expires_in: 3600 });
    }
    if (url.pathname === '/tokeninfo') {
      return Response.json({ email: 'Person@Example.com' });
    }
    return new Response(null, { status: 404 });
  },
});
afterAll(() => google.stop(true));

function file(document: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'kthx-adc-'));
  const path = join(dir, 'adc.json');
  writeFileSync(path, JSON.stringify(document));
  return path;
}

describe('an external_account credential', () => {
  const projected = file('the-projected-jwt').replace('adc.json', 'token');
  writeFileSync(projected, 'the-projected-jwt');
  const adc = file({
    type: 'external_account',
    audience:
      '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/fml-pool/providers/offsite',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: `${google.url.origin}/sts`,
    service_account_impersonation_url: `${google.url.origin}/v1/projects/-/serviceAccounts/${ACCOUNT}:generateAccessToken`,
    credential_source: { file: projected, format: { type: 'text' } },
  });

  test('is the impersonated account, with its access token', async () => {
    const creds = loadCredentials({ GOOGLE_APPLICATION_CREDENTIALS: adc });
    expect(await creds.email()).toBe(ACCOUNT);
    expect(await creds.accessToken()).toBe('impersonated');
  });

  test('mints an ID token for the kthx audience with the federated token', async () => {
    seen.length = 0;
    const creds = loadCredentials({ GOOGLE_APPLICATION_CREDENTIALS: adc });
    const token = await creds.idToken();
    expect(token.split('.')).toHaveLength(3);
    const asked = seen.find((call) => call.path.endsWith(':generateIdToken'));
    expect(asked?.authorization).toBe('Bearer federated');
    expect(JSON.parse(asked?.body ?? '{}')).toEqual({
      audience: ID_AUDIENCE,
      includeEmail: true,
    });
    expect(ID_AUDIENCE).toBe('https://kthx.dev');
    // Kept until it nears its expiry.
    await creds.idToken();
    expect(
      seen.filter((call) => call.path.endsWith(':generateIdToken')),
    ).toHaveLength(1);
  });

  test('without an account to impersonate it names no owner', () => {
    const bare = file({
      type: 'external_account',
      audience: '//iam.googleapis.com/x',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      token_url: `${google.url.origin}/sts`,
      credential_source: { file: projected },
    });
    expect(() =>
      loadCredentials({ GOOGLE_APPLICATION_CREDENTIALS: bare }),
    ).toThrow(/names no owner/);
  });
});

describe('an authorized_user credential', () => {
  test('without an ID token asks tokeninfo who it is, and mints none', async () => {
    const adc = file({
      type: 'authorized_user',
      client_id: 'c',
      client_secret: 's',
      refresh_token: 'r',
      token_uri: `${google.url.origin}/token`,
    });
    const creds = loadCredentials({ GOOGLE_APPLICATION_CREDENTIALS: adc });
    expect(await creds.accessToken()).toBe('user-access');
    expect(await creds.email()).toBe('person@example.com');
    await expect(creds.idToken()).rejects.toMatchObject({
      code: 'NO_ID_TOKEN',
    });
  });

  test('is found where gcloud writes it when nothing names a file', () => {
    const config = mkdtempSync(join(tmpdir(), 'kthx-gcloud-'));
    writeFileSync(
      join(config, 'application_default_credentials.json'),
      JSON.stringify({ type: 'authorized_user' }),
    );
    expect(loadCredentials({ CLOUDSDK_CONFIG: config }).source).toBe(
      join(config, 'application_default_credentials.json'),
    );
  });
});

test('a service account key is refused by name', () => {
  const adc = file({ type: 'service_account', client_email: 'x@y' });
  expect(() =>
    loadCredentials({ GOOGLE_APPLICATION_CREDENTIALS: adc }),
  ).toThrow(/service_account credential/);
});
