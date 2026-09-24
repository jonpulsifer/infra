/**
 * `testRegistryReachability` asks one registry whether its distribution API
 * answers. An absent registry is a result, not a refusal.
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

  // A held credential is used, so this answers whether a push would work.
  const host = registryHostOf(input.namespace);
  const store = context.adapters.registryCredentials?.() ?? null;
  const [held] = (await store?.authFor([host])) ?? [];

  return ok(await probeRegistry(input.namespace, send, held ?? null));
};
