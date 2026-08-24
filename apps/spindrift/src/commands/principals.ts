/**
 * A principal's id as a screen prints it.
 *
 * `deploys.requestedBy` and `apps.lockedBy` record the id, which is the one
 * value that survives a rename — and the one value no reader can act on. The
 * dispatcher's principal is not a `users` row at all, so it is named here
 * rather than joined; a user is looked up once per read, for every id the read
 * is about, and an id that names nobody is printed as itself rather than
 * dropped, because "somebody deleted" is still an answer.
 */
import { inArray } from 'drizzle-orm';
import type { Database } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { AUTO_DEPLOY_PRINCIPAL } from '../reconciler/auto-deploy.ts';

const AUTO_DEPLOY_LABEL = 'auto-deploy on push';

export async function principalLabels(
  db: Database,
  ids: readonly (string | null)[],
): Promise<(id: string | null) => string | undefined> {
  const wanted = [
    ...new Set(
      ids.filter(
        (id): id is string => id !== null && id !== AUTO_DEPLOY_PRINCIPAL.id,
      ),
    ),
  ];
  const named = new Map(
    wanted.length === 0
      ? []
      : (
          await db
            .select({ id: users.id, displayName: users.displayName })
            .from(users)
            .where(inArray(users.id, wanted))
        ).map((row) => [row.id, row.displayName]),
  );
  return (id) => {
    if (id === null) return undefined;
    if (id === AUTO_DEPLOY_PRINCIPAL.id) return AUTO_DEPLOY_LABEL;
    return named.get(id) ?? id;
  };
}
