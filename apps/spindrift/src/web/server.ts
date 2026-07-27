/**
 * The `web` process (§19) — UI, webhooks, and log WebSockets.
 *
 * The route table is three things and will stay three things: the one HTML
 * entry the client mounts into, a health probe, and the command surface
 * **generated** from the registry (Task 36b). The client owns navigation, so
 * there is no route per screen; the server owns commands, so there is no
 * command without a route.
 *
 * Two dependencies are passed in rather than assembled here, and both are
 * currently unbuilt in a way that is deliberate:
 *
 * - **`session`** returns `null` until Task 37 lands passkey enrolment. The
 *   consequence is that every command route answers 401 today. That is the
 *   correct behaviour for a boundary whose authentication does not exist —
 *   §21 makes this surface session-authenticated only, and a development
 *   bypass is exactly the shortcut that becomes permanent.
 * - **`context`** is therefore unreachable: it is called only after a principal
 *   has been produced. It throws rather than fabricating an adapter registry,
 *   because the deploy and build adapters arrive with Milestone 3 and a
 *   placeholder registry would let a command half-run.
 *
 * `reconciler`, the second Deployment off the same image, does not exist yet.
 */
import { loadManifest } from '../config/manifest.ts';
import index from './client/index.html';
import { webRoutes } from './routes.ts';

const manifest = await loadManifest();

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== 'production',
  // The table is assembled in `routes.ts` so a test can read it. Written
  // inline here it would sit beside this top-level `Bun.serve`, which no test
  // can import without starting a server — and this file is exactly where a
  // hand-authored route would appear.
  routes: webRoutes(index, {
    // Task 37 replaces this with a session lookup. Until it does, nobody is
    // authenticated, and the surface says so rather than assuming an operator.
    session: async () => null,
    context: () => {
      throw new Error(
        'no request context: commands are unreachable until sessions exist',
      );
    },
  }),
});

console.log(`spindrift web → ${server.url} (${manifest.installation})`);
