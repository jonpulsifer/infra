/**
 * A Function's environment, at rest.
 *
 * One sealed envelope for the whole map rather than a row per variable: the
 * map is written whole by a Save and read whole by a deploy, so a key per row
 * would buy a granularity nothing asks for and cost a join. The envelope is
 * the same {@link CredentialKeyring} the registry credentials use, under its
 * own purpose, so rotation is the one dance already documented.
 *
 * Values are write-only in the same sense §10 means it: this seam has `open`
 * for a deploy or a Run that is about to happen and nothing that hands a value
 * to a screen. A caller that wants to show the operator what is set shows the
 * keys. The operator's own code is not a screen: a Run executes the editor's
 * source against the saved values, so a handler that prints `env` prints
 * them — to the one person who set them, under v1's single-operator trust.
 */
import { z } from 'zod';
import {
  CredentialDecryptError,
  type CredentialKeyring,
} from '../crypto/credential-envelope.ts';
import type { FunctionEnv } from './contract.ts';

/** The purpose every function-environment envelope is sealed under. */
export const FUNCTION_ENV_PURPOSE = 'spindrift-function-env';

const envDocument = z.record(z.string(), z.string());

export interface FunctionEnvSealer {
  /** The whole map as one envelope, ready for the row's `env` column. */
  seal(env: FunctionEnv): Promise<string>;
  /** The map an envelope holds. `null` — no envelope — is an empty map. */
  open(sealed: string | null): Promise<FunctionEnv>;
}

/** The sealer an installation with a keyring has. */
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
 * The saved map with one Save's changes applied: a string sets, `null`
 * deletes, an absent key is kept. Sorted, so the same map seals to the same
 * plaintext whatever order the browser sent its edits in.
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
