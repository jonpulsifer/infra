/**
 * Serving the client from a bundle that was built before the image was.
 *
 * The alternative — `Bun.serve`'s HTML import, which compiles the client at
 * boot — is what the development entry uses, and it is why `bun run dev` is
 * pleasant. It is the wrong thing in a container: compiling at boot means the
 * runtime carries the compiler, so `tailwindcss`, `bun-plugin-tailwind`, and
 * TypeScript's toolchain all ship to production to rebuild, on every pod start,
 * an artifact that never changes between them.
 *
 * So the image builds `dist/` once and this module serves it. What production
 * needs at runtime shrinks to Bun plus the handful of packages the *server*
 * imports; every UI dependency is already inside the bundle.
 *
 * The route table stays generated, which is the property `routes.ts` exists to
 * protect: this reads the directory and returns one route per file, so there is
 * still no place to hand-author a path. A file appearing here is a file the
 * build emitted.
 */
import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

/** Raised when the bundle is absent — a build step was skipped, not a 404. */
export class BundleMissingError extends Error {
  override readonly name = 'BundleMissingError';
}

/**
 * `Bun.build` emits content-hashed names for everything but the entry document,
 * so every asset except `index.html` is immutable: its name changes when its
 * bytes do. That makes a one-year immutable cache correct rather than
 * optimistic, and it makes the document itself uncacheable — it is the only
 * file whose name stays put while its contents move.
 */
const IMMUTABLE = 'public, max-age=31536000, immutable';
const NEVER = 'no-cache';

const DOCUMENT = 'index.html';

/**
 * One route per built file.
 *
 * `index.html` is served at `/` because that is where the client mounts, and
 * the document references its assets relatively (`./chunk-….js`), which resolve
 * against `/` to exactly the sibling routes below.
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
    // One Response per file, constructed once and cloned per request by
    // `Bun.serve`. `Bun.file` is lazy, so this holds descriptors, not bytes.
    const response = new Response(body, {
      headers: { 'cache-control': immutable ? IMMUTABLE : NEVER },
    });
    routes[immutable ? `/${basename(file)}` : '/'] = response;
  }
  return routes;
}
