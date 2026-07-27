/**
 * Bundle the client — `bun run build`.
 *
 * The HTML entry is the graph root: `Bun.build` follows its script and style
 * tags, so this file never grows an entry list. `src/web/server.ts` serves the
 * same HTML directly in development.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

const OUT = join(import.meta.dir, 'dist');

await rm(OUT, { recursive: true, force: true });

const production = Bun.env.NODE_ENV === 'production';

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, 'src/web/client/index.html')],
  outdir: OUT,
  target: 'browser',
  minify: production,
  sourcemap: 'linked',
  // React ships a development build unless this is set.
  define: {
    'process.env.NODE_ENV': JSON.stringify(
      production ? 'production' : 'development',
    ),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const bytes = result.outputs.reduce((total, output) => total + output.size, 0);
console.log(
  `spindrift client → dist/ (${result.outputs.length} files, ${(bytes / 1024).toFixed(1)} KiB)`,
);
