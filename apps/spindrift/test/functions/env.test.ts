/**
 * A Function's environment at rest: one sealed envelope, and the merge that
 * decides what goes into it.
 *
 * The claims worth stating are the write-only ones — an envelope holds no
 * readable value, and a map that survives a round trip is the same map — plus
 * the merge's three moves: a string sets, `null` deletes, an absent name is
 * left alone. Sorting is asserted because it is what makes the same map seal
 * to the same plaintext whatever order the browser sent its edits in.
 */
import { describe, expect, test } from 'bun:test';
import { base64urlEncode } from '../../src/auth/bytes.ts';
import {
  CREDENTIAL_KEYRING_VAR,
  CredentialDecryptError,
  CredentialKeyring,
} from '../../src/crypto/credential-envelope.ts';
import { functionEnvSealer, mergeEnv } from '../../src/functions/env.ts';

/** A keyring, the way an installation Secret supplies one. */
function keyring(fill = 9): CredentialKeyring {
  const parsed = CredentialKeyring.fromEnvironment({
    [CREDENTIAL_KEYRING_VAR]: JSON.stringify({
      active: 'k1',
      keys: { k1: base64urlEncode(new Uint8Array(32).fill(fill)) },
    }),
  });
  if (parsed === null) throw new Error('the test keyring did not parse');
  return parsed;
}

describe('functionEnvSealer', () => {
  test('a sealed map comes back whole and carries no readable value', async () => {
    const sealer = functionEnvSealer(keyring());
    const sealed = await sealer.seal({ API_TOKEN: 'sekrit', GREETING: 'hi' });

    expect(sealed).not.toContain('sekrit');
    expect(await sealer.open(sealed)).toEqual({
      API_TOKEN: 'sekrit',
      GREETING: 'hi',
    });
  });

  test('no envelope is an empty environment', async () => {
    expect(await functionEnvSealer(keyring()).open(null)).toEqual({});
  });

  test('another installation’s keyring cannot open it', async () => {
    const sealed = await functionEnvSealer(keyring(1)).seal({ A: 'a' });
    await expect(functionEnvSealer(keyring(2)).open(sealed)).rejects.toThrow(
      CredentialDecryptError,
    );
  });

  test('an envelope holding something other than a name→value map is refused', async () => {
    const sealed = await keyring().seal(
      JSON.stringify({ A: { nested: true } }),
      'spindrift-function-env',
    );
    await expect(functionEnvSealer(keyring()).open(sealed)).rejects.toThrow(
      CredentialDecryptError,
    );
  });
});

describe('mergeEnv', () => {
  test('a string sets, null deletes, an absent name is kept', () => {
    expect(mergeEnv({ A: 'a', B: 'b' }, { B: null, C: 'c', A: 'a2' })).toEqual({
      A: 'a2',
      C: 'c',
    });
  });

  test('deleting a name that is not there is not an error', () => {
    expect(mergeEnv({}, { GONE: null })).toEqual({});
  });

  test('the result is sorted, whatever order the edits arrived in', () => {
    expect(Object.keys(mergeEnv({ M: 'm' }, { Z: 'z', A: 'a' }))).toEqual([
      'A',
      'M',
      'Z',
    ]);
  });
});
