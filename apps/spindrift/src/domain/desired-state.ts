/**
 * The neutral `DesiredState` core hands a deploy adapter (§6).
 *
 * §6 settles the direction of the seam: **core describes, the adapter renders.**
 * Core-renders-native was rejected because it puts every backend's schema in
 * core, which is the coupling this seam exists to break. So nothing here is a
 * Kubernetes field, a Cloud Run field, or a hosting field — it is the vocabulary
 * all three can be rendered from, and a file sync is not a special case bolted
 * onto core.
 *
 * The shape is §6's, field for field. A field this file does not name is a field
 * core does not get to describe.
 */

/**
 * What a Component is (§3, §5). `website` is not a chart branch — §7 renders it
 * as a service with `expose` forced — but it is a distinct kind here because
 * placement, not kind, chooses the artifact type, and a `website` is the one
 * kind that can land on either.
 */
export type ComponentKind = 'service' | 'website' | 'job';

/**
 * What a Build produced (§4). A deploy adapter declares which of these it
 * accepts; the placement, not the kind, decides which one is built (§6).
 */
export type ArtifactType = 'image' | 'files';

/** The thing being deployed, exactly as Build returns it (§4, §6). */
export interface Artifact {
  type: ArtifactType;
  /**
   * The identity. Correlation joins on digest everywhere in the supply chain
   * (§16), so this is what a signature and a provenance document both name.
   */
  digest: string;
  /** The addresses the same digest can be pulled by. */
  refs: readonly string[];
}

/** The digest-pinned image address shared by verification and signing. */
export function immutableImageRef(artifact: Artifact): string | null {
  if (artifact.type !== 'image') return null;
  return (
    artifact.refs.find((ref) => ref.endsWith(`@${artifact.digest}`)) ?? null
  );
}

/**
 * The address an adapter pulls the artifact by, or `null` when it has none.
 *
 * §4 lets a Build report several — the same digest is reachable at a mirror as
 * well as at the registry it was pushed to — and every backend needs exactly
 * one. The first is taken rather than a preferred one selected, because
 * preference would need a cost model, and §3 declines to have one.
 *
 * `null` is a real answer, and every adapter treats it as `INTERNAL`: an
 * artifact with no address is a Build that recorded a digest and nowhere to get
 * it, which is core's bug rather than the backend's.
 */
export function artifactAddress(artifact: Artifact): string | null {
  return artifact.refs[0] ?? null;
}

/**
 * The three exposure states, with `private` the default (§9).
 *
 * - `internal` — Target-private, authenticated at the workload boundary.
 * - `private` — internet reachable, behind the Target-native authenticated edge.
 * - `public` — intentionally unauthenticated.
 *
 * No non-public state may leave a bypassable origin, which is why exposure both
 * filters Targets and selects the artifact shape (§3, §9).
 */
export type Exposure = 'internal' | 'private' | 'public';

/**
 * A pinned reference to one config value in the Target's store (§10).
 *
 * Values are write-only: this is a reference core can render into a delivery
 * document, never a value core has read. Pinned means a concrete version, never
 * a floating latest — a config change must produce a new Deploy rather than
 * silently not applying (§10).
 *
 * The store is not named here because a Target has exactly one (§10).
 */
export interface SecretReference {
  /** The store's own name for the item, as the store adapter minted it. */
  key: string;
  /** The version pinned. */
  version: string;
}

/**
 * One environment variable and the pinned reference that fills it.
 *
 * §10 is per-key, not per-blob: the blob is elegant on Kubernetes and has no
 * cloud-runtime equivalent. There is no secret / non-secret classification
 * either, so every row is delivered the same way — the exception §10 carves out
 * is a website's build-time config, which is a Build input (§4), not this.
 */
export interface ConfigEntry {
  /** The variable name the workload reads. */
  name: string;
  secret: SecretReference;
}

/** Where the artifact can run (§3's `arch` capability). */
export interface Platform {
  os: string;
  arch: string;
}

/**
 * What the workload asks for. Quantities are opaque strings the adapter maps to
 * its backend's own units; core compares them against a Target's discovered
 * `resourceCeiling` (§3) and never invents a scheduler (§3: resolution is a
 * filter, not a scheduler).
 */
export interface Resources {
  cpu?: string;
  memory?: string;
}

/** §6's `requirements: platform/arch, resources`. */
export interface Requirements {
  platform: Platform;
  resources: Resources;
}

/**
 * §9's two layers. The canonical name always resolves — where the platform gives
 * one of its own, that *is* the canonical, so on those Targets the adapter
 * reports it back rather than being told it. The vanity name is the flat
 * single-label one a developer shares, and exists only where a mechanism for it
 * does.
 */
export interface Hostname {
  canonical: string;
  vanity?: string;
}

/**
 * Everything core knows about what should be running, in backend-neutral terms.
 *
 * `expose` and `schedule` are the two fields §6 marks as belonging to one kind:
 * `expose` to `service`, `schedule` to `job`. They are optional rather than
 * modelled as a union per kind because §6 states one flat shape, and because
 * §7's chart takes the same flat values.
 */
export interface DesiredState {
  /** The Deploy placing this state, used to trace controller-created pods (§7). */
  deploy: string;
  /** The App this Component belongs to. */
  app: string;
  /** The Component being deployed. */
  component: string;
  /** The Target it is being placed on. */
  target: string;

  kind: ComponentKind;
  artifact: Artifact;

  /** Service only. Forced on for a `website` (§7). */
  expose?: boolean;

  exposure: Exposure;

  /** Job only. A cron expression; absent means the CronJob is suspended (§7). */
  schedule?: string;

  config: readonly ConfigEntry[];
  requirements: Requirements;
  hostname: Hostname;
}
