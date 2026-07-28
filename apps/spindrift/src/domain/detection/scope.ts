/**
 * Resolve the one directory detection is allowed to inspect (§5).
 *
 * Repo scopes are caller-named and may not escape through either traversal or
 * a symlink. Archives have no named scope and unwrap exactly one lone directory.
 */
import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type DetectionSource =
  | { readonly kind: 'repo'; readonly subpath: string }
  | { readonly kind: 'archive' };

export interface ResolvedDetectionScope {
  readonly scope: string;
  readonly directory: string;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertWithin(parent: string, child: string): void {
  if (!isWithin(parent, child)) {
    throw new RangeError('scope must stay inside the repository root');
  }
}

async function repoScope(
  repositoryRoot: string,
  requestedScope: string,
): Promise<ResolvedDetectionScope> {
  const requested = requestedScope.replaceAll('\\', '/');
  if (
    requested.length === 0 ||
    isAbsolute(requested) ||
    /^[A-Za-z]:\//.test(requested)
  ) {
    throw new RangeError('scope must stay inside the repository root');
  }

  const root = resolve(repositoryRoot);
  const directory = resolve(root, requested);
  assertWithin(root, directory);

  const [realRoot, realDirectory] = await Promise.all([
    realpath(root),
    realpath(directory),
  ]);
  assertWithin(realRoot, realDirectory);

  const scope = relative(root, directory);
  return {
    scope: scope.length === 0 ? '.' : scope.split(sep).join('/'),
    directory: realDirectory,
  };
}

async function archiveScope(
  directory: string,
): Promise<ResolvedDetectionScope> {
  const entries = await readdir(directory, { withFileTypes: true });
  return {
    scope: '.',
    directory:
      entries.length === 1 && entries[0]?.isDirectory()
        ? join(directory, entries[0].name)
        : directory,
  };
}

export function resolveDetectionScope(
  repositoryRoot: string,
  source: DetectionSource,
): Promise<ResolvedDetectionScope> {
  return source.kind === 'repo'
    ? repoScope(repositoryRoot, source.subpath)
    : archiveScope(repositoryRoot);
}
