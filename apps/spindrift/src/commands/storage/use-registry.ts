/**
 * `useArtifactRegistry`: add a registry namespace to push to, and optionally put
 * it first. The probe proves only that the registry answers; push credentials
 * stay with the build route.
 */
import { z } from 'zod';
import type { AuthoredManifest } from '../../config/manifest.schema.ts';
import { ManifestError, validateManifest } from '../../config/manifest.ts';
import {
  readStoredManifest,
  writeStoredManifest,
} from '../../config/manifest-store.ts';
import { probeRegistry, type RegistryProbe } from '../../storage/registry.ts';
import { type Command, failed, ok } from '../types.ts';

export const useArtifactRegistryInput = z
  .object({
    /** Host plus at least one path segment. The probe checks the shape. */
    namespace: z.string().trim().min(1).max(255),
    /** First is where a Target with no `reachableRegistries` pulls from. */
    makeFirst: z.boolean().default(false),
  })
  .strict();

export type UseArtifactRegistryInput = z.infer<typeof useArtifactRegistryInput>;

export interface UseArtifactRegistryResult {
  readonly registries: readonly string[];
  readonly probe: RegistryProbe;
}

export const useArtifactRegistry: Command<
  UseArtifactRegistryInput,
  UseArtifactRegistryResult
> = async (input, context) => {
  const send = context.adapters.registryTransport?.() ?? null;
  if (send === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no transport to reach a registry with',
    );
  }

  const probe = await probeRegistry(input.namespace, send);
  if (!probe.answers) {
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift cannot push artifacts to ${input.namespace}: ${probe.detail}`,
    );
  }

  const stored = await readStoredManifest(context.db);
  if (stored === null) {
    return failed(
      'NOT_FOUND',
      'this installation has no stored manifest to add a registry to',
    );
  }

  // A duplicate entry would push the same digest twice. The order is the admin's
  // rank, so only `makeFirst` moves an entry.
  const declared = stored.supplyChain.registry;
  const registry = input.makeFirst
    ? [input.namespace, ...declared.filter((one) => one !== input.namespace)]
    : declared.includes(input.namespace)
      ? declared
      : [...declared, input.namespace];

  const next: AuthoredManifest = {
    ...stored,
    supplyChain: { ...stored.supplyChain, registry },
  };

  try {
    // Last write wins, since the stored manifest has no revision. Validating the
    // whole document keeps an already invalid one from being rewritten.
    await writeStoredManifest(
      context.db,
      validateManifest(next, 'the updated manifest'),
    );
  } catch (cause) {
    if (cause instanceof ManifestError) {
      return failed('NOT_DEPLOYABLE', cause.message);
    }
    throw cause;
  }

  return ok({ registries: next.supplyChain.registry, probe });
};
