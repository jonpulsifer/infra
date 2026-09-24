/**
 * Resolves the one directory detection may inspect. A repo scope may not escape
 * the root, and an archive unwraps one lone top-level directory. This is string
 * work only; `diskTree` guards against symlinks.
 */
import type { SourceTree } from './tree.ts';
import { within } from './tree.ts';

export type DetectionSource =
  | { readonly kind: 'repo'; readonly subpath: string }
  | { readonly kind: 'archive' };

export interface ResolvedDetectionScope {
  /** Repo-relative, `.` for the root, never relative to an archive's wrapper. */
  readonly scope: string;
  /** The tree path prefix to read from: the scope, or an archive's lone directory. */
  readonly prefix: string;
}

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

/** An archive holding one file at its root has no wrapper to unwrap. */
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
