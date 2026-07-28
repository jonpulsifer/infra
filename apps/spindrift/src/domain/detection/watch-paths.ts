/**
 * Derive rebuild triggers for one repo scope (§5).
 *
 * Package workspaces contribute their internal dependency graph transitively.
 * Other ecosystems degrade honestly to the named scope plus the root manifests
 * and lockfiles that exist, which is still conservative: it can overbuild but
 * cannot silently miss a root toolchain change.
 */
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readPackageManifest(
  path: string,
): Promise<PackageManifest | null> {
  if (!(await exists(path))) return null;
  try {
    return (await Bun.file(path).json()) as PackageManifest;
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
  repositoryRoot: string,
): Promise<readonly string[]> {
  const path = join(repositoryRoot, 'pnpm-workspace.yaml');
  if (!(await exists(path))) return [];

  try {
    const document = Bun.YAML.parse(await Bun.file(path).text()) as {
      packages?: unknown;
    };
    return Array.isArray(document?.packages) &&
      document.packages.every((entry) => typeof entry === 'string')
      ? document.packages
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
  repositoryRoot: string,
  rootManifest: PackageManifest,
): Promise<Map<string, WorkspacePackage>> {
  const packages = new Map<string, WorkspacePackage>();
  const patterns = new Set([
    ...packageWorkspacePatterns(rootManifest),
    ...(await pnpmWorkspacePatterns(repositoryRoot)),
  ]);
  for (const pattern of patterns) {
    const manifests = new Bun.Glob(
      `${pattern.replace(/\/+$/, '')}/package.json`,
    );
    for await (const path of manifests.scan({
      cwd: repositoryRoot,
      onlyFiles: true,
    })) {
      const manifest = await readPackageManifest(join(repositoryRoot, path));
      if (manifest?.name) {
        packages.set(manifest.name, {
          directory: dirname(path),
          manifest,
        });
      }
    }
  }
  return packages;
}

async function workspaceDependencyPaths(
  repositoryRoot: string,
  scope: string,
): Promise<string[]> {
  if (scope === '.') return [];

  const rootManifest = await readPackageManifest(
    join(repositoryRoot, 'package.json'),
  );
  const scopeManifest = await readPackageManifest(
    join(repositoryRoot, scope, 'package.json'),
  );
  if (!rootManifest || !scopeManifest) return [];

  const packages = await workspacePackages(repositoryRoot, rootManifest);
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
  repositoryRoot: string,
  scope: string,
): Promise<string[]> {
  const paths = [
    scope,
    ...(await workspaceDependencyPaths(repositoryRoot, scope)),
  ];
  for (const path of ROOT_WATCH_FILES) {
    if (await exists(join(repositoryRoot, path))) paths.push(path);
  }
  return paths;
}
