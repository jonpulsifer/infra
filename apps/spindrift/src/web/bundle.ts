/**
 * Serves the client bundle the image builds into `dist/`, so production ships
 * no compiler. Routes come from the directory listing, one per emitted file.
 */
import { readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { MONACO_BASE } from './monaco-path.ts';

/** The bundle is absent because a build step was skipped. */
export class BundleMissingError extends Error {
  override readonly name = 'BundleMissingError';
}

// `Bun.build` content-hashes every name except `index.html`, and Monaco's path
// carries its version, so every other file is immutable and only the document
// revalidates.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NEVER = 'no-cache';

const DOCUMENT = 'index.html';
const MONACO_LOADER = 'loader.js';

// `Bun.serve` clones this per request; the lazy `Bun.file` holds no bytes.
function fileResponse(path: string, cacheControl: string): Response {
  return new Response(Bun.file(path), {
    headers: { 'cache-control': cacheControl },
  });
}

/**
 * `index.html` is served at `/`, where its relative asset paths resolve to the
 * sibling routes. Monaco's tree sits in `dist/` at the path it is served from.
 */
export async function bundleRoutes(
  directory: string,
): Promise<Record<string, Response>> {
  let entries: { name: string; isFile(): boolean }[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    throw new BundleMissingError(
      `no client bundle at ${directory}: run \`bun run build\` before starting the server`,
    );
  }
  const files = entries.filter((entry) => entry.isFile()).map((e) => e.name);

  if (!files.includes(DOCUMENT)) {
    throw new BundleMissingError(
      `the client bundle at ${directory} has no ${DOCUMENT}`,
    );
  }

  const routes: Record<string, Response> = {};
  for (const file of files) {
    const document = file === DOCUMENT;
    routes[document ? '/' : `/${file}`] = fileResponse(
      join(directory, file),
      document ? NEVER : IMMUTABLE,
    );
  }
  return { ...routes, ...(await monacoRoutes(join(directory, MONACO_BASE))) };
}

/**
 * One route per file of Monaco's `min/vs` tree, under `MONACO_BASE`. The build
 * copies the tree into `dist/`; the dev server reads it from the package.
 */
export async function monacoRoutes(
  directory: string,
): Promise<Record<string, Response>> {
  let entries: { name: string; parentPath: string; isFile(): boolean }[];
  try {
    entries = await readdir(directory, {
      withFileTypes: true,
      recursive: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    entries = [];
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)));

  if (!files.includes(MONACO_LOADER)) {
    throw new BundleMissingError(
      `no Monaco tree at ${directory}: run \`bun run build\` before starting the server`,
    );
  }

  const routes: Record<string, Response> = {};
  for (const file of files) {
    const path = `${MONACO_BASE}/${file.split(sep).join('/')}`;
    routes[path] = fileResponse(join(directory, file), IMMUTABLE);
  }
  return routes;
}
