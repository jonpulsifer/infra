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
  /**
   * The account Spindrift holds a push credential for on this host, or `null`
   * where it holds none and the build route's own identity is what authorizes.
   *
   * The username and never the token: `RegistryCredentialStore` has no verb
   * that returns one, so this field is as much as any listing can say.
   */
  readonly credentialUsername: string | null;
  /** When that credential was last set, for an operator judging a rotation. */
  readonly credentialUpdatedAt: string | null;
}

export interface ListArtifactRegistriesResult {
  readonly registries: readonly ArtifactRegistryView[];
  /**
   * Whether a credential can be held at all.
   *
   * Stated up front rather than discovered by a failed save, the same way
   * `listSourceBuckets.canVerify` is: without an installation keyring there is
   * nowhere durable to seal a token, so a form would be a form that can only
   * ever report the same configuration fact.
   */
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
