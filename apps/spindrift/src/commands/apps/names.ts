/**
 * What one App has placed, and what each placement will answer to (§9).
 *
 * `setAppZone` and `setAppVanity` both preview the same fact — the names an
 * App's Deploys will publish once the write lands — over the same rows, one
 * pinning the zone and the other the vanity label. This is the query and the
 * naming rule they share, so the two commands cannot drift into previewing it
 * two different ways.
 */
import { eq } from 'drizzle-orm';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { Database } from '../../db/client.ts';
import {
  components,
  componentTargetDesired,
  targets,
  vessels,
} from '../../db/schema.ts';
import type { Reach } from '../../domain/desired-state.ts';
import {
  componentCanonical,
  coreMintsCanonical,
  type DnsZones,
  vanity,
  zoneFor,
} from '../../domain/naming.ts';

/** One Component this App has placed, and what its name is minted from. */
export interface Placement {
  readonly component: string;
  readonly reach: Reach;
  readonly adapter: TargetAdapter;
  readonly vessel: string;
  readonly id: string;
}

/**
 * Every placement this App has, with the reach the Component asks for. A
 * preview has to check all of them — an App whose web is public and whose
 * admin is private is one App with two boundaries under it.
 */
export async function placementsFor(
  db: Database,
  appId: string,
): Promise<Placement[]> {
  return db
    .selectDistinct({
      component: components.name,
      reach: components.reach,
      adapter: targets.adapter,
      vessel: vessels.name,
      id: targets.id,
    })
    .from(componentTargetDesired)
    .innerJoin(
      components,
      eq(components.id, componentTargetDesired.componentId),
    )
    .innerJoin(targets, eq(targets.id, componentTargetDesired.targetId))
    .innerJoin(vessels, eq(vessels.id, targets.vesselId))
    .where(eq(components.appId, appId));
}

/**
 * What one placement will answer on, so a result states the outcome rather
 * than the setting. Empty where the platform names its own workload — the
 * adapter reports that name back across the deploy seam and core has none to
 * predict — and empty for a Component nothing routes to. `vanityLabel` rides
 * every adapter when given, because the vanity name is the App's own choice
 * and not a substitute for a canonical core could not mint.
 */
export function namesUnder(
  app: string,
  placement: Pick<Placement, 'component' | 'reach' | 'adapter'>,
  zones: DnsZones,
  pinned: string | null,
  vanityLabel: string | null = null,
): string[] {
  const zone = zoneFor(placement.reach, zones, pinned);
  if (zone === null) return [];

  const names: string[] = [];
  if (coreMintsCanonical(placement.adapter)) {
    names.push(
      componentCanonical({ app, component: placement.component, zone }),
    );
  }
  if (vanityLabel !== null) {
    names.push(vanity(vanityLabel, zone));
  }
  return names;
}
