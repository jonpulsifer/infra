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
