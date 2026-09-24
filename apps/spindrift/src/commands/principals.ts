/**
 * Labels principal ids for screens. The auto-deploy principal has no `users`
 * row, and an id that names nobody prints as itself.
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
