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
import type { DatastoreEngine } from '../adapters/datastore/contract.ts';
import { registryHostOf } from './artifact-name.ts';

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
export const ARTIFACT_TYPES = ['image', 'files', 'vercel-output'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

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
 * The address a Target pulls the artifact by, or `null` when it has none.
 *
 * §4 lets a Build report several — the same digest is pushed to every registry
 * the installation names — and every backend needs exactly one. Which one is
 * **not** a preference and needs no cost model: it is the one this Target can
 * actually reach, which §3 already models as `reachableRegistries`.
 *
 * Taking the first instead is what put a `ghcr.io` reference on a Cloud Run
 * revision that failed at the pull, several layers past IAM and Binary
 * Authorization, with an artifact that was signed, attested and admitted.
 *
 * `reachable` empty means **no declared restriction**, not "reaches nothing" —
 * which is every Target until an operator says otherwise, and is why the
 * fallback is the first reference rather than none. A Target that declares
 * registries and matches none of them is a Deploy that must not be written at
 * all; {@link import('./placement.ts')} makes that a non-candidate before a
 * Build is ever dispatched, and `null` here is the backstop for the case that
 * gets past it.
 *
 * **A `reachableRegistries` entry is a namespace, not a host**, and getting that
 * wrong is how this function returned `null` for an artifact that was sitting in
 * the very registry the Target had named. The vocabulary is `supplyChain.
 * registry`'s — `ghcr.io/owner`, `<region>-docker.pkg.dev/<project>/<repo>` —
 * because that is what an operator copies from the manifest into a Target's
 * connection, and it is what discovery reports back. Comparing it to
 * `registryHostOf(ref)` compares a namespace to a host and never matches.
 *
 * A bare host is still honoured, because it is a legitimate thing to write when
 * a Target reaches every namespace on one registry and nobody should have to
 * enumerate them.
 */
export function artifactAddress(
  artifact: Artifact,
  reachable: readonly string[] = [],
): string | null {
  if (reachable.length === 0) return artifact.refs[0] ?? null;
  return artifact.refs.find((ref) => pullableFrom(ref, reachable)) ?? null;
}

/**
 * Whether one reference sits under any of the registries a Target named.
 *
 * The one predicate for "can this Target pull this": `artifactAddress` above
 * calls it with a concrete pull address, and `exclusionsFor` in
 * `placement.ts` calls it with the registry namespace itself, before a Build
 * exists to produce an address — which is exactly what the equality branch is
 * for, since a real reference always carries more path than its registry and
 * never needs it.
 */
export function pullableFrom(
  ref: string,
  reachable: readonly string[],
): boolean {
  return reachable.some(
    (registry) =>
      ref === registry ||
      // The namespace spelling, which is the ordinary one. The trailing slash
      // is what stops `…/i` from claiming a reference in `…/images`.
      ref.startsWith(`${registry}/`) ||
      registryHostOf(ref) === registry,
  );
}

/**
 * Where a Component can be reached from (§9).
 *
 * - `none` — no route exists, so no name resolves to it.
 * - `private` — a route on an address only the operator's own network reaches.
 * - `public` — a route on an address the internet reaches.
 *
 * The record type is the boundary, not a policy attached to it: `private` is an
 * RFC1918 address, which is unreachable from the internet whatever else is or is
 * not configured in front of it.
 */
export type Reach = 'none' | 'private' | 'public';

/**
 * Whether something authenticates in front of a Component (§9).
 *
 * `proxy` means **the Target's native authenticated edge**, never oauth2-proxy
 * specifically — §9 says "gateway external authentication on Kubernetes, or the
 * cloud runtime's own identity-aware proxy". The Component asks for the property;
 * the Target answers with a mechanism or is a non-candidate.
 */
export type Auth = 'none' | 'proxy';

/**
 * §9's hard rule, in the one form that can be checked: **if `auth` is `proxy`,
 * no unauthenticated path to the workload may exist.**
 *
 * It binds only where auth is claimed. `{private, none}` is not a bypassable
 * origin — it is deliberately unauthenticated on a network the operator owns.
 * The chart's default-deny NetworkPolicy is what enforces it, for every
 * Component whatever its reach.
 */
export const AUTH_NEEDS_A_ROUTE =
  'a Component with no route has nothing to authenticate in front of';

/**
 * The one cell of the reach/auth grid that is unsayable, as a predicate.
 *
 * A function rather than a line repeated in each schema because there are now
 * two acts that decide a Component's exposure — creating one and editing one —
 * and the whole value of the rule is that it holds for both. Two copies of the
 * comparison is two places for the grid to be wrong in one of them, which is
 * exactly the state 54 found: a rule enforced where a Component is born and
 * nowhere else.
 *
 * Every other cell is expressible, including the two the old three-state
 * exposure could not say — an unauthenticated address on your own network, and
 * an authenticated public one.
 */
export function authHasARoute(state: {
  readonly reach: Reach;
  readonly auth: Auth;
}): boolean {
  return !(state.reach === 'none' && state.auth === 'proxy');
}

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

/**
 * The variable each engine's connection is read through (§11).
 *
 * **Fixed by engine.** Never a column, never a form field, and never offered.
 * Every mainstream client for these two engines already reads these names, so a
 * settable name could only ever have been the same name typed by hand — and a
 * settable name is what lets two Postgres Datastores both claim `DATABASE_URL`
 * on one App, which is a release that comes up green with one of them silently
 * missing. The refusal lives at attach; this constant is why there is exactly
 * one thing to refuse about.
 */
export const DATASTORE_VARIABLE = {
  postgres: 'DATABASE_URL',
  valkey: 'REDIS_URL',
} as const satisfies Record<DatastoreEngine, string>;

/**
 * One attached Datastore, as the variable its connection fills.
 *
 * Deliberately **not** a {@link ConfigEntry}: no {@link SecretReference}, so no
 * version. §10 pins a config version because a config change must produce a new
 * Deploy rather than silently not applying; a Datastore credential is the
 * opposite case — the engine's operator owns its rotation, and pinning a version
 * would fight the operator for it. What is pinned here is the *reference*, which
 * is stable across every rotation behind it.
 *
 * No engine either. Core resolves the variable name once, where the Deploy's
 * intent is written, and pins the resolved name exactly as §10 pins resolved
 * config variable names. Nothing downstream branches on the engine — the
 * connection's own scheme says everything the renderer needs.
 */
export interface DatastoreAttachment {
  /** The variable, already resolved through {@link DATASTORE_VARIABLE}. */
  readonly name: string;
  /** The Datastore's stored `connection_ref` — a reference, never a credential. */
  readonly connection: string;
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

  reach: Reach;
  auth: Auth;

  /** Job only. A cron expression; absent means the CronJob is suspended (§7). */
  schedule?: string;

  /**
   * The entrypoint this release runs the image with; absent means the image's
   * own.
   *
   * Optional rather than nullable, like `expose` and `schedule` above, which is
   * also what makes every `desired` document written before these fields
   * existed read back correctly — the column is jsonb with no runtime parse, so
   * an absent key is the only shape an old row can have.
   *
   * Not per-kind: a monolith's `web`, `worker` and `cleanup` are one image run
   * three ways, so a service and a job both carry one. And it lands in
   * {@link DesiredDocument}, so it is **pinned per release** — the same
   * argument that file makes for config, read for the entrypoint: an artifact
   * replayed later must come up under the command it was released with, not
   * under whatever the Component says today. An older image may not even carry
   * the binary a newer command names.
   */
  command?: readonly string[];
  /** The arguments to {@link DesiredState.command}, or to the image's own. */
  args?: readonly string[];

  config: readonly ConfigEntry[];

  /**
   * The Datastores attached to this App when the intent was written (§11).
   *
   * Optional rather than nullable, like `expose` and `schedule` above, which is
   * also what makes every `desired` document written before this field existed
   * read back as `undefined` — the column is jsonb with no runtime parse, so an
   * absent key is the only shape an old row can have.
   *
   * It lands in {@link DesiredDocument} and is pinned, for the identical reason
   * that file argues for config: a rollback must come back up with the
   * attachment it was released with, not with whatever is attached today.
   */
  datastores?: readonly DatastoreAttachment[];

  requirements: Requirements;
  hostname: Hostname;
}

/**
 * The part of {@link DesiredState} a Deploy **pins when its intent is written**.
 *
 * §10 pinned the config document for a stated reason — "re-reading current
 * config at apply time would give a rollback the configuration of the release it
 * is rolling away from" — and the same argument covers the rest of the shape: a
 * Component edited after an intent was written must not retroactively change
 * what that intent placed. Pinning three fields and re-reading the others made a
 * rollback come back up with yesterday's artifact under today's shape.
 *
 * **Every Deploy has one.** The column is `NOT NULL`, and that is the point: an
 * intent whose meaning has to be reassembled from rows that have moved since is
 * not an intent, it is a query. There is no compose-from-rows path to fall back
 * to, because a fallback is where the bug would keep living.
 *
 * Three fields are deliberately **not** here, each because pinning it would be
 * wrong rather than merely unnecessary:
 *
 * - `deploy` — the Deploy's own id. Storing a row's primary key inside the row
 *   is a second copy that can disagree with the first.
 * - `artifact` — carried by the Build, which is immutable once `SUCCEEDED` and
 *   is what a Deploy names. Copying it here would be a cache of an immutable
 *   fact.
 * - `hostname` — a property of the **App**, not of a release. §9 makes moving an
 *   App between backends "one record re-point", which only holds if a name
 *   outlives the releases under it; a rollback that restored an older vanity
 *   name would take away the address somebody bookmarked. It is derived at apply
 *   time from the App's names, the Target's adapter, and the installation's
 *   zones, and that is correct.
 */
export type DesiredDocument = Omit<
  DesiredState,
  'deploy' | 'artifact' | 'hostname'
>;
