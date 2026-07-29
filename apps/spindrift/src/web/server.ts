/**
 * The `web` process (§19) — UI, webhooks, and log WebSockets. Production entry.
 *
 * It serves a client that was built into the image and **imports nothing from
 * the bundler**. That is the whole difference from `dev.ts`, and it is what
 * keeps `tailwindcss`, `bun-plugin-tailwind`, and the rest of the compile-time
 * toolchain out of the runtime: an HTML import anywhere in this module's graph
 * would pull them back in whether or not a request ever reached one.
 */
import { join } from 'node:path';
import { bundleRoutes } from './bundle.ts';
import { start } from './serve.ts';

const DIST = join(import.meta.dir, '../../dist');

await start(await bundleRoutes(DIST), { development: false });
