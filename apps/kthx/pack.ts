#!/usr/bin/env bun
/**
 * The CLI as `dist/kthx.tgz`, which the apex serves at `/cli/kthx.tgz`.
 *
 * Packing `apps/kthx` itself does not work and cannot be made to: its
 * dependencies are `workspace:*`, which `bun pm pack` rewrites to `0.0.0` and
 * `bun add` then looks for on the public registry, where `@repo/archive` and
 * `@repo/kthx` are not and will never be. So the CLI is bundled to one file
 * first — `bun build` inlines both workspace packages and the agent reference —
 * and the tarball carries that file and a package.json with no dependencies at
 * all. `bun add -g https://kthx.dev/cli/kthx.tgz` installs it on a machine that
 * has only Bun.
 *
 * `bun build --compile` was the alternative and is the bigger story: one ~60 MB
 * binary per platform, a matrix to build them, a chooser to serve them, and
 * `bun add -g` cannot install any of them.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

writeFileSync(
  join(dist, 'package.json'),
  `${JSON.stringify(
    {
      name: 'kthx',
      version: manifest.version,
      description: 'a directory becomes https://<name>.kthx.dev',
      type: 'module',
      bin: { kthx: 'kthx.js' },
      files: ['kthx.js'],
      engines: { bun: '>=1.4.0' },
    },
    null,
    2,
  )}\n`,
);

await Bun.$`bun pm pack --quiet --filename kthx.tgz`.cwd(dist);
const tgz = Bun.file(join(dist, 'kthx.tgz'));
console.log(`dist/kthx.tgz  ${(tgz.size / 1024).toFixed(1)} KB`);
