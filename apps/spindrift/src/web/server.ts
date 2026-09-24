/**
 * Production web entry, serving the client built into the image. An HTML import
 * here would pull the bundler and Tailwind toolchain into the runtime.
 */
import { join } from 'node:path';
import { bundleRoutes } from './bundle.ts';
import { start } from './serve.ts';

const DIST = join(import.meta.dir, '../../dist');

await start(await bundleRoutes(DIST), { development: false });
