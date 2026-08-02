/**
 * `testRegistryReachability` — ask one registry whether it is there (§16).
 *
 * The registry counterpart of `testBucketPermissions`, and it answers a
 * deliberately smaller question. That one proves the controller can *write*,
 * because it asks with the identity that would do the writing. This one proves
 * only that the distribution API answers, because §13 leaves every push
 * authorized by the build route that makes it and none of those credentials are
 * in this process. `storage/registry.ts` carries the whole of that reasoning.
 *
 * It refuses nothing about the world: a registry that is not there comes back
 * as a result saying so, because that is a row on a listing rather than a failed
 * act. The one refusal is a process with no transport to ask with.
 */
import { z } from 'zod';
import { registryHostOf } from '../../domain/artifact-name.ts';
import { probeRegistry, type RegistryProbe } from '../../storage/registry.ts';
import { type Command, failed, ok } from '../types.ts';

export const testRegistryReachabilityInput = z
  .object({
    namespace: z.string().trim().min(1, 'a registry namespace is required'),
  })
  .strict();

export type TestRegistryReachabilityInput = z.infer<
  typeof testRegistryReachabilityInput
>;

export type TestRegistryReachabilityResult = RegistryProbe;

export const testRegistryReachability: Command<
  TestRegistryReachabilityInput,
  TestRegistryReachabilityResult
> = async (input, context) => {
  const send = context.adapters.registryTransport?.() ?? null;
  if (send === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no transport to reach a registry with',
    );
  }

  // Where a credential is held, Verify exercises it — because the question an
  // operator is asking of a private registry is "will the push work", and a
  // check that deliberately asked anonymously would answer a different one and
  // report the same `401` whether the stored token was right or long revoked.
  const host = registryHostOf(input.namespace);
  const store = context.adapters.registryCredentials?.() ?? null;
  const [held] = (await store?.authFor([host])) ?? [];

  return ok(await probeRegistry(input.namespace, send, held ?? null));
};
