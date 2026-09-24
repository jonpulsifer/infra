#!/usr/bin/env bun
/**
 * Packs the CLI as `dist/kthx.tgz`, served at `/cli/kthx.tgz`, bundled to one
 * file with no dependencies: `bun pm pack` rewrites `workspace:*` to `0.0.0`,
 * which no registry has.
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

// A content hash: the pruned build tree has no `.git`, and an unchanged bundle
// keeps its id across rebuilds.
const bundle = readFileSync(join(dist, 'kthx.js'));
const build = new Bun.CryptoHasher('sha256')
  .update(bundle)
  .digest('hex')
  .slice(0, 12);

// The CLI reads this file for its own build, and the server serves it as
// `x-kthx-build`.
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
