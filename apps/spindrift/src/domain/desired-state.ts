/**
 * The backend-neutral `DesiredState` core hands a deploy adapter. Core
 * describes and the adapter renders, so no field here belongs to one backend.
 */
import type { DatastoreEngine } from '../adapters/datastore/contract.ts';
import { registryHostOf } from './artifact-name.ts';

/**
 * A `website` renders as a service with `expose` forced. It is its own kind
 * because it is the one kind whose artifact type depends on placement.
 */
export type ComponentKind = 'service' | 'website' | 'job';

/** A deploy adapter declares which it accepts; placement, not kind, decides which is built. */
export const ARTIFACT_TYPES = ['image', 'files', 'vercel-output'] as const;

export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

export interface Artifact {
  type: ArtifactType;
  /** What a signature and a provenance document both name. */
  digest: string;
  /** The addresses the same digest can be pulled by. */
  refs: readonly string[];
}

/** The digest-pinned ref of an image artifact, or null. */
export function immutableImageRef(artifact: Artifact): string | null {
  if (artifact.type !== 'image') return null;
  return (
    artifact.refs.find((ref) => ref.endsWith(`@${artifact.digest}`)) ?? null
  );
}

/**
 * The first ref under a registry the Target reaches, or null. An empty
 * `reachable` means no restriction, so the first ref is used.
 */
export function artifactAddress(
  artifact: Artifact,
  reachable: readonly string[] = [],
): string | null {
  if (reachable.length === 0) return artifact.refs[0] ?? null;
  return artifact.refs.find((ref) => pullableFrom(ref, reachable)) ?? null;
}

/**
 * `reachable` holds registry namespaces, or bare hosts that cover every
 * namespace. Placement passes a namespace as `ref` before a Build exists.
 */
export function pullableFrom(
  ref: string,
  reachable: readonly string[],
): boolean {
  return reachable.some(
    (registry) =>
      ref === registry ||
      // The trailing slash stops `…/i` from claiming a ref in `…/images`.
      ref.startsWith(`${registry}/`) ||
      registryHostOf(ref) === registry,
  );
}

/**
 * `none` has no route, `private` an RFC1918 address only the operator's network
 * reaches, and `public` an address the internet reaches.
 */
export type Reach = 'none' | 'private' | 'public';

/**
 * `proxy` asks for the Target's authenticated edge, and then no path may reach
 * the workload around it. The chart's default-deny NetworkPolicy enforces that.
 */
export type Auth = 'none' | 'proxy';

export const AUTH_NEEDS_A_ROUTE =
  'a Component with no route has nothing to authenticate in front of';

/**
 * The one invalid reach and auth pair. One predicate, so creating and editing a
 * Component enforce the same rule.
 */
export function authHasARoute(state: {
  readonly reach: Reach;
  readonly auth: Auth;
}): boolean {
  return !(state.reach === 'none' && state.auth === 'proxy');
}

/**
 * A pinned version of one config value in the Target's only store. Core renders
 * the reference and never reads the value.
 */
export interface SecretReference {
  /** The store's own name for the item, as the store adapter minted it. */
  key: string;
  version: string;
}

/** Per key, with no secret classification, so every entry is delivered the same way. */
export interface ConfigEntry {
  name: string;
  secret: SecretReference;
}

/**
 * Fixed per engine and never settable, so two Postgres Datastores on one App
 * cannot both claim `DATABASE_URL`. Attach refuses the second.
 */
export const DATASTORE_VARIABLE = {
  postgres: 'DATABASE_URL',
  valkey: 'REDIS_URL',
} as const satisfies Record<DatastoreEngine, string>;

/**
 * No version is pinned: the engine's operator rotates the credential, and the
 * reference stays stable across rotations.
 */
export interface DatastoreAttachment {
  /** Already resolved through {@link DATASTORE_VARIABLE}. */
  readonly name: string;
  /** The Datastore's stored `connection_ref`, never a credential. */
  readonly connection: string;
}

export interface Platform {
  os: string;
  arch: string;
}

/**
 * Opaque quantities the adapter maps to its backend's units. Core only compares
 * them with a Target's `resourceCeiling`.
 */
export interface Resources {
  cpu?: string;
  memory?: string;
}

export interface Requirements {
  platform: Platform;
  resources: Resources;
}

/**
 * `canonical` always resolves; where the platform names it, the adapter reports
 * it back. `vanity` exists only where a mechanism for it does.
 */
export interface Hostname {
  canonical: string;
  vanity?: string;
}

/** Flat, because the chart takes flat values: `expose` is service-only and `schedule` job-only. */
export interface DesiredState {
  /** Used to trace controller-created pods back to the Deploy. */
  deploy: string;
  app: string;
  component: string;
  target: string;

  kind: ComponentKind;
  artifact: Artifact;

  /** Service only. Forced on for a `website`. */
  expose?: boolean;

  reach: Reach;
  auth: Auth;

  /** Job only. A cron expression; absent means the job is unscheduled. */
  schedule?: string;

  /**
   * Absent means the image's own entrypoint. Optional because older jsonb rows
   * lack the key; pinned per release, so a replayed artifact keeps its command.
   */
  command?: readonly string[];
  /** The arguments to {@link DesiredState.command}, or to the image's own. */
  args?: readonly string[];

  config: readonly ConfigEntry[];

  /** Attached when the intent was written. Optional because older jsonb rows lack the key. */
  datastores?: readonly DatastoreAttachment[];

  requirements: Requirements;
  hostname: Hostname;
}

/**
 * What a Deploy pins when its intent is written; the row, the Build and the App
 * own `deploy`, `artifact` and `hostname`. A rollback replays only `schedule`,
 * `command`, `args` and `config`. Reach, auth, expose and `datastores` stay
 * current: exposure and attachment are decided by their own acts, not by a
 * release.
 */
export type DesiredDocument = Omit<
  DesiredState,
  'deploy' | 'artifact' | 'hostname'
>;
