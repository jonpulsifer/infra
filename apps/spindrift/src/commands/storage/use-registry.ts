/**
 * `useArtifactRegistry` — push artifacts to this registry, and optionally to it
 * first (§16, §20).
 *
 * The registry twin of `useSourceBucket`, down to the shape of the act: *push
 * here*, and optionally *let an unqualified Target pull from here*. Naming a
 * namespace that is already declared with `makeFirst` is how the tie-break
 * moves, which is why this is not called `addArtifactRegistry` — the add is
 * idempotent and the interesting half is often the other one.
 *
 * **It checks, then writes**, for the same reason the bucket act does, but the
 * check is weaker and the difference matters. A bucket is verified *writable*.
 * A registry is verified only to *answer* — §13 leaves the push credential with
 * the build route, so no check made from here can prove a push will land. What
 * this refuses is the mistake that check can catch: a namespace that is not one,
 * and a host that is not a registry. A push that is refused on credentials
 * fails in the build log, and no amount of checking from this process moves it
 * earlier.
 *
 * **Named cost, inherited from `configureInstallation` and stated at
 * `useSourceBucket`:** the manifest has no revision column, so this
 * read-modify-write loses a concurrent edit whole. It therefore changes exactly
 * one key and validates the whole document on the way out, so the edit it might
 * lose is always somebody else's *other* key.
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
    /**
     * A registry namespace — host plus at least one path segment, which is what
     * `componentRepositories` appends `{app}/{component}` to. Its shape is
     * checked by the probe, where the reason for each half is written down.
     */
    namespace: z.string().trim().min(1).max(255),
    /**
     * Whether this becomes the registry a Target with no declared
     * `reachableRegistries` pulls from — the manifest's first entry (§16).
     */
    makeFirst: z.boolean().default(false),
  })
  .strict();

export type UseArtifactRegistryInput = z.infer<typeof useArtifactRegistryInput>;

export interface UseArtifactRegistryResult {
  readonly registries: readonly string[];
  /** What the probe learned, so the caller need not ask a second time. */
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

  // Declared once. Moving the tie-break onto a namespace already present is a
  // reorder rather than a second entry, which is what keeps the same digest from
  // being pushed twice to one destination — and an add that is *not* made first
  // leaves the order it found, because that order is the admin rank.
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
    // Validated on the way out even though one key moved, for the reason
    // `useSourceBucket` states: a stored manifest that was already drifting
    // from the schema must not be made durable again by an act that never
    // looked at the rest of it.
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
