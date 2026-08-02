/**
 * The file surface detection is allowed to see (§5).
 *
 * Detection is "one algorithm over one directory", and until now *directory*
 * meant a path on a disk. That is why the ladder never ran outside a test: the
 * one moment a developer wants an answer — connecting a repository — is a
 * moment when nothing has been checked out, and cloning to answer a question
 * about a directory listing is a build the operator did not ask for.
 *
 * So the ladder reads through this instead. Two methods, because two are what
 * the ladder actually uses: the set of paths, and one file's text. A git tree
 * and an unpacked archive can both answer those, and neither can answer more
 * without becoming a filesystem.
 *
 * **Paths are root-relative, `/`-separated, and name files only.** Directories
 * are implied by the files inside them, which is how git's own tree reads and
 * is the only shape both sides can produce without inventing entries.
 */

import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { RepositoryRef } from '../repository.ts';

export interface SourceTree {
  /**
   * Every file, root-relative. Implementations cache: the ladder asks more
   * than once and a second walk would answer a question already answered.
   */
  paths(): Promise<readonly string[]>;
  /** One file's text, or `null` when it is not there. */
  readText(path: string): Promise<string | null>;
}

/** Whether a path names a file that is in the tree. */
export async function exists(tree: SourceTree, path: string): Promise<boolean> {
  return (await tree.paths()).includes(path);
}

/**
 * Whether a path stays inside the root it is relative to.
 *
 * Pure string work, and deliberately so. A git tree has no `..` to resolve and
 * no symlink to follow — every entry is already root-relative — so the only
 * place a real filesystem check is owed is {@link diskTree}, which does it.
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

/** A tree over a directory on disk — an unpacked archive, or a checkout. */
export function diskTree(root: string): SourceTree {
  const absoluteRoot = resolve(root);
  let listing: Promise<readonly string[]> | null = null;

  /**
   * Refuse a read that leaves the root, by real path.
   *
   * The string check above is not enough here and is the one place it is not:
   * an unpacked archive is attacker-supplied bytes, and a symlink inside one
   * can point anywhere. `Bun.file().text()` would follow it.
   */
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

/** What {@link gitHubTree} reads through — a narrowing of `RepositoryReader`. */
export interface TreeReader {
  /** Every blob path at one exact commit, root-relative. */
  treePaths(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
  ): Promise<readonly string[]>;
  /** One file at one exact commit, or `null` when it is not there. */
  readFile(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null>;
}

/**
 * A tree over one commit of a repository, read through the host.
 *
 * No clone, no checkout, no temporary directory: the listing is one recursive
 * tree call and each file is one blob read. That is what makes detection
 * something the connect screen can do while the operator is still looking at
 * it.
 *
 * Pinned to a commit rather than a branch, because everything downstream — the
 * proposal shown, the `spindrift.yaml` written into the configuration PR — is a
 * statement about one revision, and a branch that moved mid-flow would make
 * those two statements about different code.
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
