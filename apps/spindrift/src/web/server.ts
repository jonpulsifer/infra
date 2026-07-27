/**
 * The `web` process (§19) — UI, webhooks, and log WebSockets. Today it is a
 * scaffold: it validates the installation manifest at boot and serves the
 * client bundle.
 *
 * It deliberately serves no route but the UI and a health probe. Every act the
 * browser performs will reach one dispatch endpoint generated from the command
 * registry; the first hand-authored route is the drift that turns an internal
 * protocol into the API §21 declined to declare.
 *
 * `reconciler`, the second Deployment off the same image, does not exist yet.
 */
import { loadManifest } from '../config/manifest.ts';
import index from './client/index.html';

const manifest = await loadManifest();

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== 'production',
  routes: {
    '/': index,
    '/healthz': new Response('ok\n'),
  },
});

console.log(`spindrift web → ${server.url} (${manifest.installation})`);
