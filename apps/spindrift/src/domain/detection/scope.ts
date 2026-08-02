/**
 * Resolve the one directory detection is allowed to inspect (§5).
 *
 * Repo scopes are caller-named and may not escape the root. Archives have no
 * named scope and unwrap exactly one lone directory — the shape every `zip -r`
 * and every `git archive` produces, which a developer dropping output from a
 * coding agent (story 28) should not have to know about.
 *
 * This is pure string work over a {@link SourceTree}'s listing. It used to
 * resolve real paths and follow symlinks, and that job did not disappear — it
 * moved into `diskTree`, which is the only implementation that has symlinks to
 * be lied to by. A git tree has none, and putting the check where the risk is
 * means scope resolution is now testable without a filesystem.
 */
import type { SourceTree } from './tree.ts';
import { within } from './tree.ts';

export type DetectionSource =
  | { readonly kind: 'repo'; readonly subpath: string }
  | { readonly kind: 'archive' };

export interface ResolvedDetectionScope {
  /**
   * What this scope is *called* — repo-relative, `.` for the root.
   *
   * This is the value that reaches `spindrift.yaml`'s path and the App's
   * `sourceRepoSubpath`, so it is always relative to the repository, never to
   * whatever wrapper directory an archive happened to arrive in.
   */
  readonly scope: string;
  /**
   * Where to *read* from, as a prefix on tree paths.
   *
   * The same as `scope` for a repository. For an archive it is the unwrapped
   * lone directory, which is exactly the difference between the two.
   */
  readonly prefix: string;
}

/** Normalize a caller-named repo scope, or refuse it. */
function repoScope(subpath: string): ResolvedDetectionScope {
  const requested = subpath.replaceAll('\\', '/').replace(/\/+$/, '');
  if (requested === '' || requested === '.') {
    return { scope: '.', prefix: '.' };
  }
  if (!within(requested)) {
    throw new RangeError('scope must stay inside the repository root');
  }
  const scope = requested.replace(/^\.\//, '');
  return { scope, prefix: scope };
}

/**
 * Unwrap a lone top-level directory, if that is what the archive is.
 *
 * "Lone" means every entry shares one first segment *and* that segment is a
 * directory rather than a single file at the root — an archive of one file is
 * not a wrapper to unwrap.
 */
async function archiveScope(tree: SourceTree): Promise<ResolvedDetectionScope> {
  const paths = await tree.paths();
  if (paths.length === 0) return { scope: '.', prefix: '.' };

  const first = new Set(paths.map((path) => path.split('/')[0]));
  if (first.size !== 1) return { scope: '.', prefix: '.' };

  const [only] = first;
  if (only === undefined || paths.includes(only)) {
    return { scope: '.', prefix: '.' };
  }
  return { scope: '.', prefix: only };
}

export function resolveDetectionScope(
  tree: SourceTree,
  source: DetectionSource,
): Promise<ResolvedDetectionScope> {
  return source.kind === 'repo'
    ? Promise.resolve(repoScope(source.subpath))
    : archiveScope(tree);
}
