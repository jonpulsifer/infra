/**
 * The Target row an adapter call reaches a vessel's datastore surface through.
 * `undefined` when the vessel kind hosts no database or its surface was never
 * probed.
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
