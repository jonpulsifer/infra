/**
 * The development entry for `bun run dev`, where the HTML import compiles the
 * client on demand. It lives apart from `server.ts` because that import pulls
 * the compile toolchain into any module graph that holds it.
 */
import index from './client/index.html';
import { start } from './serve.ts';

await start({ '/': index }, { development: true });
