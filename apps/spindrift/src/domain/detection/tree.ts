/**
 * The file surface detection reads, so it runs over a git tree or an unpacked
 * archive without a checkout. Paths are root-relative, `/`-separated, and name
 * files only; directories are implied by their files.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositoryRef } from '../repository.ts';

export interface SourceTree {
  /** Every file path. Implementations cache it; detection asks repeatedly. */
  paths(): Promise<readonly string[]>;
  /** One file's text, or `null` when it is not there. */
  readText(path: string): Promise<string | null>;
}

export async function exists(tree: SourceTree, path: string): Promise<boolean> {
  return (await tree.paths()).includes(path);
}

/**
 * Whether a relative path stays inside its root, by string only.
 * {@link diskTree} also compares real paths.
 */
export function within(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

export function diskTree(root: string): SourceTree {
  const absoluteRoot = resolve(root);
  let listing: Promise<readonly string[]> | null = null;

  // An unpacked archive is untrusted and Bun.file() follows symlinks, so a read
  // must resolve inside the real root.
  async function resolveWithin(path: string): Promise<string | null> {
    if (!within(path)) return null;
    const absolute = resolve(absoluteRoot, path);
    const [realRoot, real] = await Promise.all([
      realpath(absoluteRoot).catch(() => null),
      realpath(absolute).catch(() => null),
    ]);
    if (realRoot === null || real === null) return null;
    const inside = relative(realRoot, real);
    return inside !== '..' &&
      !inside.startsWith(`..${sep}`) &&
      !isAbsolute(inside)
      ? real
      : null;
  }

  return {
    paths() {
      listing ??= Array.fromAsync(
        new Bun.Glob('**/*').scan({
          cwd: absoluteRoot,
          onlyFiles: true,
          dot: true,
          followSymlinks: false,
        }),
      ).then((found) => found.map((path) => path.split(sep).join('/')).sort());
      return listing;
    },
    async readText(path) {
      const absolute = await resolveWithin(path);
      if (absolute === null) return null;
      return Bun.file(absolute)
        .text()
        .catch(() => null);
    },
  };
}

/** The slice of `RepositoryReader` that {@link gitHubTree} reads through. */
export interface TreeReader {
  treePaths(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
  ): Promise<readonly string[]>;
  /** `null` when the file is not at that commit. */
  readFile(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null>;
}

/**
 * Pinned to a commit, so the proposal shown and the `spindrift.yaml` written
 * into the configuration PR describe the same revision.
 */
export function gitHubTree(
  reader: TreeReader,
  ref: RepositoryRef,
  fullName: string,
  commit: string,
): SourceTree {
  let listing: Promise<readonly string[]> | null = null;
  const files = new Map<string, Promise<string | null>>();

  return {
    paths() {
      listing ??= reader.treePaths(ref, fullName, commit);
      return listing;
    },
    readText(path) {
      if (!within(path)) return Promise.resolve(null);
      let file = files.get(path);
      if (file === undefined) {
        file = reader.readFile(ref, fullName, commit, path);
        files.set(path, file);
      }
      return file;
    },
  };
}
