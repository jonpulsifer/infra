/**
 * The development entry — `bun run dev`.
 *
 * Bun's HTML import is the thing worth having here: `Bun.serve` compiles the
 * client on demand, so an edit to a view is visible without a build step, and
 * `bunfig.toml`'s Tailwind plugin compiles the stylesheet in the same pass.
 *
 * That convenience is exactly what production must not pay for, which is why
 * this is a separate file rather than a branch inside `server.ts`. The import
 * below is a bundler directive: it pulls the compile-time toolchain into
 * whatever module graph contains it, and a `NODE_ENV` check would not undo
 * that — the dependency is decided at import, not at call.
 */
import index from './client/index.html';
import { start } from './serve.ts';

await start({ '/': index }, { development: true });
