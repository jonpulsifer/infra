/**
 * Everything the two entries share: validate the manifest, assemble the table,
 * listen.
 *
 * It exists so `server.ts` and `dev.ts` differ in exactly one expression — how
 * the client is served — rather than in two copies of a `Bun.serve` call that
 * would drift apart in the parts that must not differ.
 *
 * The three dependencies below are the whole of what the process is:
 *
 * - **`session`** resolves the opaque cookie to a principal, or to nobody. A
 *   command route with nobody behind it answers 401, which is §21's
 *   session-authenticated-only surface working rather than a boundary that is
 *   not built.
 * - **`context`** is built per request, after a principal exists, and carries
 *   the injected clock, the database, the manifest, and the adapters this
 *   installation actually has (`src/adapters/registry.ts`).
 * - **`auth`** is the one surface reachable without a session, because it is
 *   what produces one. `src/auth/routes.ts` carries why it cannot be a command.
 */
import { createAdapterRegistry } from '../adapters/registry.ts';
import type { EnrolmentDeps } from '../auth/enrol.ts';
import { resolveSession } from '../auth/session.ts';
import { systemClock } from '../commands/types.ts';
import { loadManifest } from '../config/manifest.ts';
import { createDb } from '../db/client.ts';
import { type ClientRoute, webRoutes } from './routes.ts';

/**
 * Where the enrolment token arrives.
 *
 * The installation Secret, and deliberately **not** the installation manifest:
 * the manifest describes an installation and is the document §20 asks an
 * operator to write and hand around, while this is the credential that claims
 * one. Absent is a legal state — enrolment is then impossible, which is the
 * right posture for an installation nobody has been given the key to.
 */
export const ENROLMENT_TOKEN_VAR = 'SPINDRIFT_ENROLMENT_TOKEN';

export async function start(
  client: Record<string, ClientRoute>,
  { development }: { development: boolean },
): Promise<void> {
  const manifest = await loadManifest();
  const db = createDb();
  const adapters = createAdapterRegistry({ manifest });

  const auth: EnrolmentDeps = {
    db,
    clock: systemClock,
    relyingParty: {
      id: manifest.controlPlane.hostname,
      name: manifest.installation,
      origin: `https://${manifest.controlPlane.hostname}`,
    },
    enrolmentToken: Bun.env[ENROLMENT_TOKEN_VAR]?.trim() || null,
  };

  const server = Bun.serve({
    port: Number(Bun.env.PORT ?? 3000),
    development,
    routes: webRoutes(
      client,
      {
        session: (request) => resolveSession(request, auth),
        context: (principal) => ({
          principal,
          clock: systemClock,
          db,
          adapters,
          manifest,
        }),
      },
      auth,
    ),
  });

  console.log(`spindrift web → ${server.url} (${manifest.installation})`);
}
