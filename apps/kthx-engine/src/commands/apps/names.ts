/**
 * The placement query and naming rule shared by the `setAppZone` and
 * `setAppVanity` previews.
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

/** One placed Component, with what its name is minted from. */
export interface Placement {
  readonly component: string;
  readonly reach: Reach;
  readonly adapter: TargetAdapter;
  readonly vessel: string;
  readonly id: string;
}

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
 * The hostnames one placement will answer on. Empty where nothing routes to the
 * Component; no canonical where the platform names its own workload.
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
