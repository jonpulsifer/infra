/**
 * Derive rebuild triggers for one repo scope (§5).
 *
 * Package workspaces contribute their internal dependency graph transitively.
 * Other ecosystems degrade honestly to the named scope plus the root manifests
 * and lockfiles that exist, which is still conservative: it can overbuild but
 * cannot silently miss a root toolchain change.
 *
 * Reads through a {@link SourceTree} rather than the filesystem, so the same
 * derivation answers for a repository nobody has checked out. The workspace
 * walk that used to `scan()` the disk now matches glob patterns against the
 * tree's listing — the same `Bun.Glob`, asked whether a string matches instead
 * of asked what is on a disk.
 */
import { dirname } from 'node:path';
import type { SourceTree } from './tree.ts';

const ROOT_WATCH_FILES = [
  'package.json',
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'yarn.lock',
  'go.mod',
  'go.sum',
  'go.work',
  'go.work.sum',
  'pyproject.toml',
  'uv.lock',
  'poetry.lock',
  'Cargo.toml',
  'Cargo.lock',
] as const;

interface PackageManifest {
  readonly name?: string;
  readonly workspaces?:
    | readonly string[]
    | { readonly packages?: readonly string[] };
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

interface WorkspacePackage {
  readonly directory: string;
  readonly manifest: PackageManifest;
}

function joinPath(scope: string, file: string): string {
  return scope === '.' ? file : `${scope}/${file}`;
}

async function readPackageManifest(
  tree: SourceTree,
  path: string,
): Promise<PackageManifest | null> {
  const document = await tree.readText(path);
  if (document === null) return null;
  try {
    return JSON.parse(document) as PackageManifest;
  } catch {
    return null;
  }
}

function packageWorkspacePatterns(
  manifest: PackageManifest,
): readonly string[] {
  const workspaces = manifest.workspaces;
  if (!workspaces) return [];
  if (Array.isArray(workspaces)) return workspaces;
  return (
    (workspaces as { readonly packages?: readonly string[] }).packages ?? []
  );
}

async function pnpmWorkspacePatterns(
  tree: SourceTree,
): Promise<readonly string[]> {
  const document = await tree.readText('pnpm-workspace.yaml');
  if (document === null) return [];

  try {
    const parsed = Bun.YAML.parse(document) as { packages?: unknown };
    return Array.isArray(parsed?.packages) &&
      parsed.packages.every((entry) => typeof entry === 'string')
      ? parsed.packages
      : [];
  } catch {
    return [];
  }
}

function dependencyNames(manifest: PackageManifest): string[] {
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ];
}

async function workspacePackages(
  tree: SourceTree,
  rootManifest: PackageManifest,
): Promise<Map<string, WorkspacePackage>> {
  const patterns = new Set([
    ...packageWorkspacePatterns(rootManifest),
    ...(await pnpmWorkspacePatterns(tree)),
  ]);
  if (patterns.size === 0) return new Map();

  const manifestPaths = (await tree.paths()).filter((path) =>
    path.endsWith('package.json'),
  );
  const packages = new Map<string, WorkspacePackage>();
  for (const pattern of patterns) {
    const glob = new Bun.Glob(`${pattern.replace(/\/+$/, '')}/package.json`);
    for (const path of manifestPaths) {
      if (!glob.match(path)) continue;
      const manifest = await readPackageManifest(tree, path);
      if (manifest?.name) {
        packages.set(manifest.name, { directory: dirname(path), manifest });
      }
    }
  }
  return packages;
}

/**
 * Every directory the root manifest declares as a workspace package.
 *
 * Exported for discovery (§5's "discover" branch), which needs the same answer
 * for a different reason: watch paths ask *which packages does this one depend
 * on*, discovery asks *which packages are there at all*. Both are the workspace
 * glob walk, and running two of them would be two ways to disagree about what a
 * monorepo contains.
 */
export async function workspaceDirectories(
  tree: SourceTree,
): Promise<readonly string[]> {
  const rootManifest = await readPackageManifest(tree, 'package.json');
  if (rootManifest === null) return [];
  const packages = await workspacePackages(tree, rootManifest);
  return [...packages.values()]
    .map((entry) => entry.directory)
    .filter((directory) => directory !== '.')
    .sort();
}

async function workspaceDependencyPaths(
  tree: SourceTree,
  scope: string,
): Promise<string[]> {
  if (scope === '.') return [];

  const rootManifest = await readPackageManifest(tree, 'package.json');
  const scopeManifest = await readPackageManifest(
    tree,
    joinPath(scope, 'package.json'),
  );
  if (!rootManifest || !scopeManifest) return [];

  const packages = await workspacePackages(tree, rootManifest);
  const paths: string[] = [];
  const queued = dependencyNames(scopeManifest);
  const seen = new Set<string>();

  while (queued.length > 0) {
    const name = queued.shift();
    if (!name || seen.has(name)) continue;
    seen.add(name);

    const dependency = packages.get(name);
    if (!dependency) continue;
    if (dependency.directory !== scope) paths.push(dependency.directory);
    queued.push(...dependencyNames(dependency.manifest));
  }

  return paths;
}

export async function deriveWatchPaths(
  tree: SourceTree,
  scope: string,
): Promise<string[]> {
  const paths = [scope, ...(await workspaceDependencyPaths(tree, scope))];
  const listing = new Set(await tree.paths());
  for (const path of ROOT_WATCH_FILES) {
    if (listing.has(path)) paths.push(path);
  }
  return paths;
}
