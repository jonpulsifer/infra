/**
 * Serves the client bundle the image builds into `dist/`, so production ships
 * no compiler. Routes come from the directory listing, one per emitted file.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** The bundle is absent because a build step was skipped. */
export class BundleMissingError extends Error {
  override readonly name = 'BundleMissingError';
}

// `Bun.build` content-hashes every name except `index.html`, so every other
// file is immutable and only the document revalidates.
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NEVER = 'no-cache';

const DOCUMENT = 'index.html';

/**
 * `index.html` is served at `/`, where its relative asset paths resolve to the
 * sibling routes.
 */
export async function bundleRoutes(
  directory: string,
): Promise<Record<string, Response>> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch {
    throw new BundleMissingError(
      `no client bundle at ${directory}: run \`bun run build\` before starting the server`,
    );
  }

  if (!files.includes(DOCUMENT)) {
    throw new BundleMissingError(
      `the client bundle at ${directory} has no ${DOCUMENT}`,
    );
  }

  const routes: Record<string, Response> = {};
  for (const file of files) {
    const body = Bun.file(join(directory, file));
    const immutable = file !== DOCUMENT;
    // `Bun.serve` clones this per request; the lazy `Bun.file` holds no bytes.
    const response = new Response(body, {
      headers: { 'cache-control': immutable ? IMMUTABLE : NEVER },
    });
    routes[immutable ? `/${basename(file)}` : '/'] = response;
  }
  return routes;
}
