/**
 * `listArtifactRegistries` lists the manifest's registry namespaces in order,
 * with any held push credential. It makes no network call; reachability is
 * probed per row on request.
 */
import { z } from 'zod';
import {
  type RegistryFlavour,
  registryFlavour,
  registryHostOf,
} from '../../domain/artifact-name.ts';
import { type Command, ok } from '../types.ts';

export const listArtifactRegistriesInput = z.object({}).strict();

export type ListArtifactRegistriesInput = z.infer<
  typeof listArtifactRegistriesInput
>;

export interface ArtifactRegistryView {
  /** As the manifest declares it: host plus one path segment. */
  readonly namespace: string;
  readonly host: string;
  readonly flavour: RegistryFlavour;
  /**
   * The manifest's first entry, which a Target with no `reachableRegistries`
   * pulls from.
   */
  readonly first: boolean;
  /**
   * The account a push credential is held for on this host, or `null` when the
   * build route's own identity authorizes.
   */
  readonly credentialUsername: string | null;
  readonly credentialUpdatedAt: string | null;
}

export interface ListArtifactRegistriesResult {
  readonly registries: readonly ArtifactRegistryView[];
  /** False without an installation keyring, where no token can be sealed. */
  readonly canHoldCredentials: boolean;
}

export const listArtifactRegistries: Command<
  ListArtifactRegistriesInput,
  ListArtifactRegistriesResult
> = async (_input, context) => {
  const store = context.adapters.registryCredentials?.() ?? null;
  const held = new Map(
    (await store?.list())?.map((one) => [one.host, one]) ?? [],
  );

  return ok({
    canHoldCredentials: store !== null,
    registries: context.manifest.supplyChain.registry.map(
      (namespace, index) => {
        const host = registryHostOf(namespace);
        const credential = held.get(host);
        return {
          namespace,
          host,
          flavour: registryFlavour(host),
          first: index === 0,
          credentialUsername: credential?.username ?? null,
          credentialUpdatedAt: credential?.updatedAt.toISOString() ?? null,
        };
      },
    ),
  });
};
