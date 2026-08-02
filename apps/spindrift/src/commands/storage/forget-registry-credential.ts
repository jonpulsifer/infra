/**
 * `forgetRegistryCredential` — stop holding one registry's push credential.
 *
 * **Forgetting is not revoking**, and the result says so rather than implying
 * otherwise. Spindrift holds a copy of a token somebody else issued; deleting
 * the row means no future build is handed it, and it means nothing at all about
 * the token's validity at the registry. An operator who is rotating because a
 * token leaked has a second thing to do, and the sentence names it.
 *
 * The same shape `disconnectTarget` uses for the same honesty reason: an act
 * that removes Spindrift's record of something does not reach out and tear the
 * thing down.
 */
import { z } from 'zod';
import { registryHostOf } from '../../domain/artifact-name.ts';
import { type Command, failed, ok } from '../types.ts';

export const forgetRegistryCredentialInput = z
  .object({
    /** A declared namespace or a bare host; the credential is the host's. */
    registry: z.string().trim().min(1).max(255),
  })
  .strict();

export type ForgetRegistryCredentialInput = z.infer<
  typeof forgetRegistryCredentialInput
>;

export interface ForgetRegistryCredentialResult {
  readonly host: string;
  /** `false` when there was nothing held for that host. */
  readonly forgotten: boolean;
  /** The sentence the operator reads, including what this did not do. */
  readonly detail: string;
}

export const forgetRegistryCredential: Command<
  ForgetRegistryCredentialInput,
  ForgetRegistryCredentialResult
> = async (input, context) => {
  const store = context.adapters.registryCredentials?.() ?? null;
  if (store === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no credential keyring, so it holds no registry credential to forget',
    );
  }

  const host = registryHostOf(input.registry);
  const forgotten = await store.forget(host);

  return ok({
    host,
    forgotten,
    detail: forgotten
      ? `Spindrift no longer holds a credential for ${host}. The token itself is still valid — revoke it at the registry if that is why it is being removed.`
      : `Spindrift held no credential for ${host}`,
  });
};
