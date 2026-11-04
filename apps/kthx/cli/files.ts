/**
 * The files a directory deploys: everything but dotfiles, `node_modules` and
 * `kthx.json`, with a lone top-level directory taken as the site root.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SiteFile } from '../server/bucket.ts';
import { KthxError } from './error.ts';

/** A deploy's ceilings: the bytes and files one site holds. */
export const MAX_SITE_BYTES = 32 * 1024 * 1024;
export const MAX_FILES = 2000;

export function included(path: string): boolean {
  return (
    path !== 'kthx.json' &&
    !path
      .split('/')
      .some((part) => part.startsWith('.') || part === 'node_modules')
  );
}

function regular(dir: string, path: string): boolean {
  try {
    return statSync(join(dir, path)).isFile();
  } catch {
    // A dangling link is an error, never a silently smaller site.
    throw new KthxError('DANGLING_LINK', `${join(dir, path)} points nowhere`);
  }
}

/** Glob's `onlyFiles` skips symlinks, so stat decides. */
function walk(dir: string): string[] {
  return [
    ...new Bun.Glob('**/*').scanSync({
      cwd: dir,
      dot: true,
      followSymlinks: true,
      onlyFiles: false,
    }),
  ]
    .map((path) => path.replaceAll('\\', '/'))
    .filter(included)
    .filter((path) => regular(dir, path))
    .sort();
}

/** Refused before anything is sent: an entry page, and the ceilings. */
export function collect(dir: string): SiteFile[] {
  let paths = walk(dir);
  const tops = new Set(paths.map((path) => path.split('/')[0]));
  const [top] = tops;
  // Zipping or building into one folder is common; the folder is the site.
  if (
    tops.size === 1 &&
    top !== undefined &&
    paths.every((path) => path.includes('/'))
  ) {
    paths = paths.map((path) => path.slice(top.length + 1));
    dir = join(dir, top);
  }
  if (paths.length > MAX_FILES) {
    throw new KthxError(
      'TOO_LARGE',
      `${paths.length} files; a site holds at most ${MAX_FILES}`,
    );
  }
  if (!paths.includes('index.html')) {
    throw new KthxError('NO_INDEX', `no index.html at the root of ${dir}`);
  }
  const files = paths.map((path) => ({
    path,
    bytes: new Uint8Array(readFileSync(join(dir, path))),
  }));
  const size = files.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (size > MAX_SITE_BYTES) {
    throw new KthxError(
      'TOO_LARGE',
      `${size} bytes; a site holds at most ${MAX_SITE_BYTES}`,
    );
  }
  return files;
}
