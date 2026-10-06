import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '@repo/archive/bytes';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialDecryptError,
  CredentialKeyring,
  CredentialKeyringConfigError,
} from '../../src/crypto/credential-envelope.ts';

const key = (fill: number) => base64urlEncode(new Uint8Array(32).fill(fill));

const env = (
  active: string,
  keys: Record<string, string>,
): Record<string, string> => ({
  [CREDENTIAL_KEYRING_VAR]: JSON.stringify({ active, keys }),
});

describe('credential keyring', () => {
  test('is absent when the installation Secret does not configure one', () => {
    expect(CredentialKeyring.fromEnvironment({})).toBeNull();
  });

  test('refuses malformed documents and non-256-bit keys', () => {
    expect(() =>
      CredentialKeyring.fromEnvironment({
        [CREDENTIAL_KEYRING_VAR]: 'not json',
      }),
    ).toThrow(CredentialKeyringConfigError);
    expect(() =>
      CredentialKeyring.fromEnvironment(
        env('current', { current: key(1).slice(1) }),
      ),
    ).toThrow('32 base64url-encoded bytes');
    expect(() =>
      CredentialKeyring.fromEnvironment(env('missing', { old: key(1) })),
    ).toThrow('active key is absent');
  });

  test('round-trips only under the envelope purpose', async () => {
    const ring = CredentialKeyring.fromEnvironment(
      env('2026-07', { '2026-07': key(7) }),
    )!;
    const sealed = await ring.seal(
      '{"accessToken":"not-printed"}',
      'spindrift-github-app-key',
    );

    expect(await ring.open(sealed, 'spindrift-github-app-key')).toEqual({
      plaintext: '{"accessToken":"not-printed"}',
      needsRotation: false,
    });
    await expect(
      ring.open(sealed, 'spindrift-github-webhook-secret'),
    ).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  test('detects ciphertext tampering', async () => {
    const ring = CredentialKeyring.fromEnvironment(
      env('current', { current: key(2) }),
    )!;
    const sealed = JSON.parse(
      await ring.seal('credential', 'spindrift-github-app-key'),
    ) as { ciphertext: string };
    const middle = Math.floor(sealed.ciphertext.length / 2);
    sealed.ciphertext = `${sealed.ciphertext.slice(0, middle)}${
      sealed.ciphertext[middle] === 'A' ? 'B' : 'A'
    }${sealed.ciphertext.slice(middle + 1)}`;

    await expect(
      ring.open(JSON.stringify(sealed), 'spindrift-github-app-key'),
    ).rejects.toBeInstanceOf(CredentialDecryptError);
  });

  test('opens a legacy envelope and requests lazy rotation', async () => {
    const old = CredentialKeyring.fromEnvironment(env('old', { old: key(3) }))!;
    const sealed = await old.seal('credential', 'spindrift-github-app-key');
    const rotated = CredentialKeyring.fromEnvironment(
      env('new', { new: key(4), old: key(3) }),
    )!;

    expect(await rotated.open(sealed, 'spindrift-github-app-key')).toEqual({
      plaintext: 'credential',
      needsRotation: true,
    });
    const rewritten = await rotated.seal(
      'credential',
      'spindrift-github-app-key',
    );
    expect(await rotated.open(rewritten, 'spindrift-github-app-key')).toEqual({
      plaintext: 'credential',
      needsRotation: false,
    });
  });
});
