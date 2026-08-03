/**
 * Where a Component's artifact is published, and under what tags.
 *
 * §16 names the registries an installation pushes to — "every artifact is
 * pushed to and pulled from" them — and each value is a **namespace**. A
 * namespace is not a place an image can be pushed: a registry host followed by
 * one path segment is not a repository, and every registry rejects it as a name
 * before authentication is relevant. Something has to append the rest, and this
 * is that place.
 *
 * **Several registries, one repository path under each.** Two Targets on one
 * installation cannot always share a registry, so the same Component resolves
 * to one repository per registry and the same digest is pushed to all of them.
 *
 * This is not a DNS name and `naming.ts` is not its home, for the same reason
 * {@link import('./workload-name.ts')} is not there: §9's names are what a user
 * types, chosen for how they read and constrained by certificates. A repository
 * name is a path a registry either accepts or refuses, and the only thing it
 * owes anyone is being the same one next time.
 *
 * **The shape is `{registry}/{app}/{component}`**, settled with the operator
 * rather than derived. Nesting rather than `{app}-{component}` follows
 * {@link import('./naming.ts').componentCanonical} and its stated reason: a
 * hyphen-joined name is ambiguous the moment either half contains a hyphen,
 * which both are allowed to. GHCR accepts multi-segment package paths, and a
 * listing that nests is one an operator can read.
 *
 * **It is unique per (App name, Component name), which is not the same as per
 * Component.** Where two Apps share a name their Components share a repository.
 * That is live today and it is not this module's to fix: `apps.name` carries no
 * unique constraint. Encoding the App's id here would dodge it at the cost of a
 * registry listing no one can read, and would leave the identity gap in place
 * everywhere else.
 */

/**
 * One segment of a repository path, per the OCI distribution spec.
 *
 * Lowercase alphanumerics, separated by one `.`, one `_`, two `_`, or any run
 * of `-`. Deliberately not a normalizer: a name that cannot be a path component
 * is refused at dispatch and named in the refusal, because the alternative is
 * projecting two distinct names onto one repository and pushing a Component's
 * image over another Component's.
 */
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/;

/** Whether a name can stand as one segment of a repository path. */
export function isPathComponent(value: string): boolean {
  return value.length > 0 && value.length <= 63 && PATH_COMPONENT.test(value);
}

/** What a repository name is assembled from. */
export interface ArtifactRepositoryParts {
  /** The installation's registry namespaces (§16) — a host and a namespace each. */
  readonly registries: readonly string[];
  readonly app: string;
  readonly component: string;
}

/**
 * The repositories one Component's artifacts are pushed to, one per registry.
 *
 * Returns `null` when either half cannot be a path component, so the caller
 * refuses with the offending name rather than handing a registry something it
 * will answer `NAME_INVALID` to — which is the failure this module exists to
 * end, and which cost a build every step up to `Build and push` to discover.
 *
 * All or none, because the App and Component names are what a registry rejects
 * and they are the same names under every registry. A partial answer would push
 * to one destination and silently not to another, which reads as "Cloud Run
 * cannot pull an artifact the cluster is already running".
 *
 * Order is the manifest's order, and it is the order `refs` is recorded in — so
 * `refs[0]` remains the first registry, which is what a Target that declares no
 * `reachableRegistries` still gets.
 */
export function componentRepositories(
  parts: ArtifactRepositoryParts,
): readonly string[] | null {
  if (!isPathComponent(parts.app)) return null;
  if (!isPathComponent(parts.component)) return null;
  return parts.registries.map(
    (registry) => `${registry}/${parts.app}/${parts.component}`,
  );
}

/** The registry host a reference is pulled from — everything before the first `/`. */
export function registryHostOf(reference: string): string {
  return reference.split('/')[0] ?? '';
}

/**
 * Whether a string is a registry namespace §16 could push under.
 *
 * A host, then at least one path segment — which is the shape
 * {@link componentRepositories} appends to, and the shape a namespace has to
 * already be for the result to be a repository a registry accepts. A bare host
 * is refused here rather than at the first push, for the same reason a bad
 * component name is: the alternative costs a build every step up to `Build and
 * push` to discover.
 *
 * The host is required to *look* like one — a dot, a port, or `localhost` —
 * because `alpine/git` is a legal repository path under Docker Hub's implicit
 * host and an illegal namespace here: §16 names the registries explicitly, so
 * a namespace that leaves the host to be inferred is one whose destination
 * depends on which client resolves it.
 */
export function isRegistryNamespace(value: string): boolean {
  const [host, ...path] = value.split('/');
  if (host === undefined || path.length === 0) return false;
  if (!isRegistryHost(host)) return false;
  return path.every((segment) => isPathComponent(segment));
}

/** A host a registry answers on: DNS name, optional port, or `localhost`. */
function isRegistryHost(host: string): boolean {
  const [name, port, ...rest] = host.split(':');
  if (name === undefined || rest.length > 0) return false;
  if (port !== undefined && !/^[0-9]{1,5}$/.test(port)) return false;
  if (name === 'localhost') return true;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
    name,
  );
}

/**
 * Which registry product answers for a host.
 *
 * Vendor vocabulary, not installation identity, so it belongs here rather than
 * in the manifest §20 puts installation-naming values in: `ghcr.io` is the same
 * host for everybody, and what changes per installation is *which* of them an
 * operator pushes to — which is `supplyChain.registry` and already a value.
 *
 * It carries no behaviour beyond {@link registryApiBase} and a label. A flavour
 * this list does not know is `other`, which is a registry that works exactly
 * the same way: the distribution API is the contract, and the flavour is only
 * ever how a listing reads.
 */
export type RegistryFlavour =
  | 'artifactRegistry'
  | 'dockerHub'
  | 'ghcr'
  | 'other';

/**
 * Docker Hub, under every name it answers to.
 *
 * Three spellings and only one of them is the distribution API. A namespace is
 * written `docker.io/…`, the canonical index is `index.docker.io`, and the
 * registry itself is `registry-1.docker.io` — so a probe that used the host as
 * written would report Docker Hub unreachable on a namespace that pushes fine.
 */
const DOCKER_HUB_HOSTS: ReadonlySet<string> = new Set([
  'docker.io',
  'index.docker.io',
  'registry-1.docker.io',
]);

const DOCKER_HUB_API_HOST = 'registry-1.docker.io';

/** Which registry product a host is, by the only thing available: its name. */
export function registryFlavour(host: string): RegistryFlavour {
  const name = host.split(':')[0] ?? host;
  if (DOCKER_HUB_HOSTS.has(name)) return 'dockerHub';
  if (name === 'ghcr.io') return 'ghcr';
  // `gcr.io` and its regional prefixes are served by Artifact Registry now, so
  // they are the same product under an older name rather than a fourth flavour.
  if (
    name.endsWith('.pkg.dev') ||
    name === 'gcr.io' ||
    name.endsWith('.gcr.io')
  )
    return 'artifactRegistry';
  return 'other';
}

/**
 * The registries one route can actually publish to (§13, §16).
 *
 * §16 says every artifact is pushed to every registry, and that sentence has an
 * unstated precondition: that the pushing thing can authenticate to all of
 * them. It cannot. §13 wants each push authorized by the route that makes it —
 * a federated token for the cloud builder, the run's own token for hosted CI —
 * and those identities do not reach the same set. The cloud builder's metadata
 * token is good for one vendor's registries and nothing else; the hosted run
 * logs into GHCR *and* federates to the artifact registry, which is why it has
 * never had to think about this.
 *
 * A push to a registry the route cannot authenticate to does not fail politely.
 * `buildctl` exports every reference in one operation, so a `401` on one
 * destination fails the whole export — half an hour into a build, with the
 * artifact built and nothing published anywhere. Narrowing here is what turns
 * that into "this route publishes where it can", and what makes an App naming a
 * route a decision with a legible consequence: the artifact lands in fewer
 * places, and a Target that cannot pull from any of them is not one this route
 * can build for. `setAppBuildRoute` refuses exactly that, up front.
 *
 * The stored credentials widen it back. That is the whole purpose of §16's
 * named exception to "nothing stored": a host no federation reaches becomes
 * reachable the moment an installation holds a login for it.
 */
export function publishableRegistries(input: {
  readonly registries: readonly string[];
  /** Flavours this route's own identity authorizes, from the adapter. */
  readonly selfAuthorized: readonly RegistryFlavour[];
  /** Hosts this installation holds a stored credential for. */
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
 * The OCI distribution API root a namespace's registry answers on.
 *
 * `https` with no fallback. A registry reached over plaintext is one whose
 * answer to "are you there" can be written by anything on the path, and this
 * function's only caller is deciding whether to write a destination into the
 * installation manifest.
 */
export function registryApiBase(host: string): string {
  const name = host.split(':')[0] ?? host;
  const authority = DOCKER_HUB_HOSTS.has(name) ? DOCKER_HUB_API_HOST : host;
  return `https://${authority}/v2/`;
}

/**
 * The tag that names *what was built*, derived from the bundle digest.
 *
 * §12 settles retention as "retain artifacts by **tagging** and let the
 * registry's own cleanup policy delete", with "N = 10 doubl[ing] as rollback
 * depth". A push that carries only the implicit `:latest` gives that policy
 * nothing to count — every build overwrites the one tag and the rollback depth
 * is one.
 *
 * The bundle digest rather than the commit because it is the one identifier
 * **both** routes have: an upload has no commit, and §16 already makes the
 * bundle digest "a build parameter on every route" for exactly that reason. It
 * is also content-addressed, so rebuilding identical source lands on the tag it
 * landed on last time instead of burning a retention slot.
 *
 * `sha256:…` becomes `sha256-…` because a tag may not contain a colon.
 */
export function bundleTag(bundleDigest: string): string {
  return bundleDigest.replace(':', '-');
}

/** The moving tag, kept so the newest artifact is always one a human can pull. */
export const MOVING_TAG = 'latest';

/**
 * Every tag one build pushes, most specific first.
 *
 * `latest` moves and the digest tag does not, which is the whole point: the
 * moving one is for a person typing a pull command, and the immutable one is
 * what §12 counts and what a rollback names. Nothing in the deploy path reads
 * either — an artifact is pinned by digest (§16) — so a tag can never be the
 * reason a Deploy resolves to the wrong image.
 */
export function artifactTags(bundleDigest: string): readonly string[] {
  return [bundleTag(bundleDigest), MOVING_TAG];
}
