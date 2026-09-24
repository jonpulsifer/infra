/**
 * A Function's environment at rest: the whole map sealed as one envelope by the
 * {@link CredentialKeyring}, under its own purpose.
 */
import { z } from 'zod';
import {
  CredentialDecryptError,
  type CredentialKeyring,
} from '../crypto/credential-envelope.ts';
import type { FunctionEnv } from './contract.ts';

export const FUNCTION_ENV_PURPOSE = 'spindrift-function-env';

const envDocument = z.record(z.string(), z.string());

export interface FunctionEnvSealer {
  seal(env: FunctionEnv): Promise<string>;
  /** For a deploy or a Run, never a screen. `null` opens as an empty map. */
  open(sealed: string | null): Promise<FunctionEnv>;
}

export function functionEnvSealer(
  keyring: CredentialKeyring,
): FunctionEnvSealer {
  return {
    seal(env) {
      return keyring.seal(JSON.stringify(env), FUNCTION_ENV_PURPOSE);
    },
    async open(sealed) {
      if (sealed === null) return {};
      const { plaintext } = await keyring.open(sealed, FUNCTION_ENV_PURPOSE);
      let document: unknown;
      try {
        document = JSON.parse(plaintext);
      } catch {
        throw new CredentialDecryptError(
          'the function environment envelope does not hold JSON',
        );
      }
      const parsed = envDocument.safeParse(document);
      if (!parsed.success) {
        throw new CredentialDecryptError(
          'the function environment envelope is not a map of names to values',
        );
      }
      return parsed.data;
    },
  };
}

/**
 * A string sets, `null` deletes, an absent key is kept. Sorted, so the same map
 * seals to the same plaintext whatever order the edits arrived in.
 */
export function mergeEnv(
  current: FunctionEnv,
  changes: Readonly<Record<string, string | null>>,
): FunctionEnv {
  const merged = new Map(Object.entries(current));
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) merged.delete(name);
    else merged.set(name, value);
  }
  return Object.fromEntries([...merged].sort(([a], [b]) => (a < b ? -1 : 1)));
}
