/**
 * Proposes candidate directories in a repository for a person to choose from.
 * The chosen one becomes a named scope; nothing here writes an App.
 */
import {
  type DetectionResult,
  detectScope,
  type ZeroConfigPlanner,
} from './ladder.ts';
import type { SourceTree } from './tree.ts';
import { workspaceDirectories } from './watch-paths.ts';

/** Matched as any path segment, so a deep vendored tree never floods the list. */
const IGNORED_SEGMENTS = new Set([
  'node_modules',
  'vendor',
  'third_party',
  'testdata',
  'fixtures',
  '.git',
  '.next',
  '.output',
  '.venv',
  'dist',
  'build',
  'target',
  'out',
]);

/** `index.html` is here because detection can answer for a directory of pages. */
const CANDIDATE_MANIFESTS = new Set([
  'index.html',
  'package.json',
  'go.mod',
  'Cargo.toml',
  'pyproject.toml',
  'requirements.txt',
  'Gemfile',
  'Dockerfile',
]);

/**
 * ponytail: fixed at 2, which covers `apps/web` and `services/api`. Raise it, or
 * read the project graph, if a repository nests deeper.
 */
const MAX_DEPTH = 2;

/** Past this many, the list stops being a choice. */
const MAX_CANDIDATES = 24;

function ignored(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_SEGMENTS.has(segment));
}

/**
 * Declared workspace packages first, then other manifest directories the walk
 * finds, since a workspace declares only one ecosystem. The root is excluded.
 */
export async function discoverScopes(
  tree: SourceTree,
): Promise<readonly string[]> {
  const declared = (await workspaceDirectories(tree)).filter(
    (directory) => !ignored(directory),
  );

  const walked = new Set<string>();
  for (const path of await tree.paths()) {
    if (ignored(path)) continue;
    const segments = path.split('/');
    const file = segments.pop();
    if (file === undefined || !CANDIDATE_MANIFESTS.has(file)) continue;
    if (segments.length === 0 || segments.length > MAX_DEPTH) continue;
    walked.add(segments.join('/'));
  }
  for (const directory of declared) walked.delete(directory);

  return [...declared, ...[...walked].sort()].slice(0, MAX_CANDIDATES);
}

/**
 * Named scopes as given; otherwise the root, then discovered scopes when the
 * root is not an App. Unsupported outcomes stay listed with their reason.
 */
export async function scanRepository(
  tree: SourceTree,
  planner: ZeroConfigPlanner,
  scopes?: readonly string[],
): Promise<readonly DetectionResult[]> {
  const inspect = (scope: string) =>
    detectScope({ tree, source: { kind: 'repo', subpath: scope }, planner });

  if (scopes !== undefined) return Promise.all(scopes.map(inspect));

  const root = await inspect('.');
  if (root.outcome === 'detected') return [root];
  return [
    root,
    ...(await Promise.all((await discoverScopes(tree)).map(inspect))),
  ];
}
