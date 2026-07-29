/**
 * Production adapter wiring that is not an adapter behavior of its own.
 *
 * The installer deliberately projects a token outside Kubernetes' default
 * service-account path. The registry must follow that declared path while still
 * reading the rotating file at request time.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import {
  IDENTITY_TOKEN_PATH_VAR,
  installationServiceAccountToken,
} from '../../src/adapters/registry.ts';

test('the installation token provider follows the projected path', async () => {
  const path = join('/tmp', `spindrift-identity-token-${crypto.randomUUID()}`);
  await Bun.write(path, 'first-token\n');

  try {
    const token = installationServiceAccountToken({
      [IDENTITY_TOKEN_PATH_VAR]: path,
    });
    expect(await token()).toBe('first-token');

    await Bun.write(path, 'rotated-token\n');
    expect(await token()).toBe('rotated-token');
  } finally {
    await Bun.file(path).delete();
  }
});
