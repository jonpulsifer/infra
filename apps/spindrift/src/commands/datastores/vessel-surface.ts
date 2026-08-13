/**
 * The Target row behind a vessel's datastore surface (§11).
 *
 * A Datastore is anchored to its vessel, but an adapter call still needs a
 * Target: the connection an adapter addresses and the adapter key itself both
 * live on the surface row. This is the one hop from boundary to surface —
 * `DATASTORE_SURFACE_BY_VESSEL_KIND` says which adapter can host a database on
 * a vessel of this kind, and `(vessel_id, adapter)` is unique, so the answer
 * is at most one row.
 *
 * `undefined` twice over, deliberately collapsed: a vessel kind that hosts no
 * database at all, and a vessel of a hosting kind whose surface was never
 * probed into existence. Both mean the same thing to every caller — there is
 * nothing here to provision into, tear down through, or offer.
 */
import type { Database } from '../../db/client.ts';
import type { VesselKind } from '../../domain/vessel.ts';
import { DATASTORE_SURFACE_BY_VESSEL_KIND } from '../../domain/vessel.ts';

export async function datastoreSurfaceTargetOf(
  db: Database,
  vessel: { readonly id: string; readonly kind: VesselKind },
) {
  const adapter = DATASTORE_SURFACE_BY_VESSEL_KIND[vessel.kind];
  if (adapter === undefined) return undefined;
  return db.query.targets.findFirst({
    where: (targets, { eq, and }) =>
      and(eq(targets.vesselId, vessel.id), eq(targets.adapter, adapter)),
  });
}
