/**
 * Where a Component's artifact is published, and under what tags. A registry
 * namespace is a host and a path, which no registry accepts as a repository,
 * so this module appends the App and Component names.
 */

/**
 * One repository path segment, per the OCI distribution spec. It refuses and
 * never normalizes, so two names cannot collapse onto one repository.
 */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

export function isPathComponent(value: string): boolean {
  return value.length > 0 && value.length <= 63 && PATH_COMPONENT.test(value);
}

export interface ArtifactRepositoryParts {
  /** Registry namespaces, each a host followed by a path. */
  readonly registries: readonly string[];
  readonly app: string;
  readonly component: string;
}

/**
 * One repository per registry, in manifest order, or null when either name is
 * not a path segment. Two Apps with one name share them: `apps.name` is not unique.
 */
export function componentRepositories(
  parts: ArtifactRepositoryParts,
): readonly string[] | null {
  if (!isPathComponent(parts.app)) return null;
  if (!isPathComponent(parts.component)) return null;
  return parts.registries.map((registry) =>
    // Docker Hub allows two path levels and denies a nested push, so the App
    // and Component join with a hyphen there.
    registryFlavour(registryHostOf(registry)) === 'dockerHub'
      ? `${registry}/${parts.app}-${parts.component}`
      : `${registry}/${parts.app}/${parts.component}`,
  );
}

export function registryHostOf(reference: string): string {
  return reference.split('/')[0] ?? '';
}

/**
 * A host and at least one path segment. The host must be a dotted name or
 * `localhost`, so an implicit Docker Hub path such as `alpine/git` is refused.
 */
export function isRegistryNamespace(value: string): boolean {
  const [host, ...path] = value.split('/');
  if (host === undefined || path.length === 0) return false;
  if (!isRegistryHost(host)) return false;
  return path.every((segment) => isPathComponent(segment));
}

function isRegistryHost(host: string): boolean {
  const [name, port, ...rest] = host.split(':');
  if (name === undefined || rest.length > 0) return false;
  if (port !== undefined && !/^[0-9]{1,5}$/.test(port)) return false;
  if (name === 'localhost') return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    name,
  );
}

/** A host the list does not know is `other`, which speaks the same distribution API. */
export type RegistryFlavour =
  | 'artifactRegistry'
  | 'dockerHub'
  | 'ghcr'
  | 'other';

/** Every name Docker Hub answers to. Only DOCKER_HUB_API_HOST serves the distribution API. */
const DOCKER_HUB_HOSTS: ReadonlySet<string> = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
]);

const DOCKER_HUB_API_HOST = 'registry-1.docker.io';

export function registryFlavour(host: string): RegistryFlavour {
  const name = host.split(':')[0] ?? host;
  if (DOCKER_HUB_HOSTS.has(name)) return 'dockerHub';
  if (name === 'ghcr.io') return 'ghcr';
  // Artifact Registry serves `gcr.io` and its regional hosts.
  if (
    name.endsWith('.pkg.dev') ||
    name === 'gcr.io' ||
    name.endsWith('.gcr.io')
  )
    return 'artifactRegistry';
  return 'other';
}

/**
 * The registries a route can authenticate to, by its own identity or a stored
 * credential. `buildctl` exports every reference at once, so one 401 fails the push.
 */
export function publishableRegistries(input: {
  readonly registries: readonly string[];
  readonly selfAuthorized: readonly RegistryFlavour[];
  /** Hosts with a stored registry credential. */
  readonly storedHosts?: ReadonlySet<string>;
}): string[] {
  return input.registries.filter((registry) => {
    const host = registryHostOf(registry);
    return (
      input.selfAuthorized.includes(registryFlavour(host)) ||
      (input.storedHosts?.has(host) ?? false)
    );
  });
}

/**
 * `https` with no fallback: the caller writes the answer into the installation
 * manifest, and anything on the path can forge a plaintext reply.
 */
export function registryApiBase(host: string): string {
  const name = host.split(':')[0] ?? host;
  const authority = DOCKER_HUB_HOSTS.has(name) ? DOCKER_HUB_API_HOST : host;
  return `https://${authority}/v2/`;
}

/**
 * The immutable tag that registry retention counts. The bundle digest exists on
 * every route, even an upload with no commit, and a tag may not contain a colon.
 */
export function bundleTag(bundleDigest: string): string {
  return bundleDigest.replace(':', '-');
}

/** Kept so a person can pull the newest artifact without knowing its digest. */
export const MOVING_TAG = 'latest';

export function artifactTags(bundleDigest: string): readonly string[] {
  return [bundleTag(bundleDigest), MOVING_TAG];
}

/**
 * Names the artifact a Build produced, never a Deploy's config hash. It falls
 * back to the commit while only source exists, and to `none` before that.
 */
export function artifactSummary(
  build:
    | {
        readonly artifactType: string;
        readonly artifactDigest: string | null;
        readonly commit: string | null;
      }
    | null
    | undefined,
): string {
  if (!build) return 'none';
  if (build.artifactDigest) {
    return `${build.artifactType} · ${build.artifactDigest.slice(0, 12)}`;
  }
  if (build.commit) {
    return `${build.artifactType} from ${build.commit.slice(0, 7)}`;
  }
  return 'none';
}
