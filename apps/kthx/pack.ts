#!/usr/bin/env bun
/**
 * The CLI as `dist/kthx.tgz`, which the apex serves at `/cli/kthx.tgz`.
 *
 * Packing `apps/kthx` itself does not work and cannot be made to: its
 * dependencies are `workspace:*`, which `bun pm pack` rewrites to `0.0.0` and
 * `bun add` then looks for on the public registry, where `@repo/archive` and
 * `@repo/kthx` are not and will never be. So the CLI is bundled to one file
 * first — `bun build` inlines what it imports, which is `@repo/kthx`'s agent
 * reference and favicon — and the tarball carries that file and a package.json
 * with no dependencies at all. `bun add -g https://kthx.dev/cli/kthx.tgz` installs it on a machine that
 * has only Bun.
 *
 * `bun build --compile` was the alternative and is the bigger story: one ~60 MB
 * binary per platform, a matrix to build them, a chooser to serve them, and
 * `bun add -g` cannot install any of them.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import manifest from './package.json' with { type: 'json' };

const here = import.meta.dir;
const dist = join(here, 'dist');
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const built = await Bun.build({
  entrypoints: [join(here, 'cli/main.ts')],
  outdir: dist,
  target: 'bun',
  naming: 'kthx.js',
});
if (!built.success) {
  for (const log of built.logs) console.error(log);
  throw new Error('bundling the CLI failed');
}

/**
 * The build id: the first twelve hex of the bundle's own sha256.
 *
 * Not the git sha, which is the obvious answer and is not available where this
 * runs — the Dockerfile packs from a `turbo prune` tree, which has no `.git`.
 * The content hash is the better identity anyway: it differs exactly when the
 * command line differs, so a rebuild of unchanged source does not tell every
 * installed copy that an update is available.
 */
const bundle = readFileSync(join(dist, 'kthx.js'));
const build = new Bun.CryptoHasher('sha256')
  .update(bundle)
  .digest('hex')
  .slice(0, 12);

// Beside the bundle in the tarball, and beside the tarball in the server's
// image: the CLI reads it to know itself and the server serves it as
// `x-kthx-build`, and there is one file so the two cannot disagree.
writeFileSync(
  join(dist, 'version.json'),
  `${JSON.stringify(
    {
      version: manifest.version,
      build,
      date: new Date().toISOString().slice(0, 10),
    },
    null,
    2,
  )}\n`,
);

writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kthx',
      version: manifest.version,
      description: 'a directory becomes https://<name>.kthx.dev',
      type: 'module',
      bin: { kthx: 'kthx.js' },
      files: ['kthx.js', 'version.json'],
      engines: { bun: '>=1.4.0' },
    },
    null,
    2,
  )}\n`,
);

await Bun.$`bun pm pack --quiet --filename kthx.tgz`.cwd(dist);
const tgz = Bun.file(join(dist, 'kthx.tgz'));
console.log(
  `dist/kthx.tgz  ${(tgz.size / 1024).toFixed(1)} KB  ${manifest.version}+${build}`,
);
