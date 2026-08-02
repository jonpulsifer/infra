/**
 * `listArtifactRegistries` — the registries every artifact is pushed to (§16).
 *
 * The other half of what the Storage screen is about. A source bucket holds the
 * bundle a build is handed; a registry holds what the build produced. They are
 * the same screen because they are the same question — *where does this
 * installation keep things* — and they are separate sections because a bundle
 * is an input and an artifact is an output, and nothing deploys a bundle that
 * has not been built.
 *
 * **Order is meaningful and the list says so.** `artifact-name.ts` records
 * `refs` in the manifest's order, and `desired-state.ts` gives a Target that
 * declares no `reachableRegistries` the first one — which is every Target until
 * an operator says otherwise. So `first` is not decoration: it is which registry
 * an unqualified Target pulls from.
 *
 * **Nothing here reaches the network.** Unlike buckets there is no `canVerify`,
 * because a registry probe needs no federated identity — see `storage/registry.ts`.
 * Reachability is per row and on request, for the same reason bucket
 * verification is: N registries must not mean N calls on load.
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

/** One declared registry namespace, as a listing reads it. */
export interface ArtifactRegistryView {
  /** The namespace as the manifest declares it: host plus one path segment. */
  readonly namespace: string;
  readonly host: string;
  readonly flavour: RegistryFlavour;
  /**
   * Whether this is the one a Target with no declared `reachableRegistries`
   * pulls from — the manifest's first entry, and the only sense in which the
   * order of the list means anything (§16).
   */
  readonly first: boolean;
}

export interface ListArtifactRegistriesResult {
  readonly registries: readonly ArtifactRegistryView[];
}

export const listArtifactRegistries: Command<
  ListArtifactRegistriesInput,
  ListArtifactRegistriesResult
> = async (_input, context) => {
  return ok({
    registries: context.manifest.supplyChain.registry.map(
      (namespace, index) => {
        const host = registryHostOf(namespace);
        return {
          namespace,
          host,
          flavour: registryFlavour(host),
          first: index === 0,
        };
      },
    ),
  });
};
