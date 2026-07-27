/**
 * Everything the two entries share: validate the manifest, assemble the table,
 * listen.
 *
 * It exists so `server.ts` and `dev.ts` differ in exactly one expression — how
 * the client is served — rather than in two copies of a `Bun.serve` call that
 * would drift apart in the parts that must not differ.
 *
 * The dependencies passed to the command surface are the same in both, and both
 * are currently unbuilt in a way that is deliberate:
 *
 * - **`session`** returns `null` until Task 37 lands passkey enrolment, so
 *   every command route answers 401. That is the correct behaviour for a
 *   boundary whose authentication does not exist — §21 makes this surface
 *   session-authenticated only, and a development bypass is exactly the
 *   shortcut that becomes permanent.
 * - **`context`** is therefore unreachable: it is called only after a principal
 *   has been produced. It throws rather than fabricating an adapter registry,
 *   because the deploy and build adapters arrive with Milestone 3 and a
 *   placeholder registry would let a command half-run.
 */
import { loadManifest } from '../config/manifest.ts';
import { type ClientRoute, webRoutes } from './routes.ts';

export async function start(
  client: Record<string, ClientRoute>,
  { development }: { development: boolean },
): Promise<void> {
  const manifest = await loadManifest();

  const server = Bun.serve({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    routes: webRoutes(client, {
      session: async () => null,
      context: () => {
        throw new Error(
          'no request context: commands are unreachable until sessions exist',
        );
      },
    }),
  });

  console.log(`spindrift web → ${server.url} (${manifest.installation})`);
}
