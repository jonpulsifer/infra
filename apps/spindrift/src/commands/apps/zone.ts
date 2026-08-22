/**
 * `setAppZone` — an App names the zone its names are minted in (§9).
 *
 * §9 gives an installation a set of zones, each stating what it can serve, and
 * this is the App's say inside that. It is the act §9's "one record re-point"
 * describes at the zone level: the App keeps its name's shape and changes which
 * domain it hangs under, and the next Deploy publishes the record.
 *
 * **It is a preference, not an override.** `zoneFor` falls through to the first
 * zone serving a Component's reach whenever the pin cannot serve it, so an App
 * pinned to a public-only zone whose Component flips to `private` gets a private
 * name in a zone that answers privately rather than a record on a boundary the
 * operator said that zone does not answer on.
 *
 * That fall-through is exactly why the pin is checked *here* as well. Left to
 * the reconciler it would be a Deploy that quietly lands on another domain and
 * says so to a log — the App's name would change without anyone asking. Refused
 * where the developer is standing, the two facts that disagree are both on the
 * screen: the zone's reaches, and the reaches this App's Components actually
 * have.
 *
 * Clearing the choice is the same command with a null zone, which puts the App
 * back to the installation's default — not to some other zone.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps } from '../../db/schema.ts';
import { coreMintsCanonical, zoneFor } from '../../domain/naming.ts';
import { targetLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';
import { namesUnder, placementsFor } from './names.ts';

export const setAppZoneInput = z
  .object({
    appId: z.uuid(),
    /**
     * The zone to mint in, or null to go back to the installation's default.
     *
     * Nullable rather than optional: "leave it as it is" and "clear it" are
     * different acts and an absent key cannot mean both.
     */
    zone: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetAppZoneInput = z.infer<typeof setAppZoneInput>;

export interface SetAppZoneResult {
  readonly appId: string;
  /** What the App now mints in, or null for the installation's default. */
  readonly zone: string | null;
  /** The names this App's placed Components will answer on after this. */
  readonly hostnames: readonly string[];
}

export const setAppZone: Command<SetAppZoneInput, SetAppZoneResult> = async (
  input,
  context,
) => {
  const [app] = await context.db
    .select({ id: apps.id, name: apps.name })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  const zones = context.manifest.dns.zones;
  if (input.zone !== null) {
    const named = zones.find((zone) => zone.name === input.zone);
    if (named === undefined) {
      return failed(
        'NOT_FOUND',
        `this installation mints no names in ${input.zone}. ` +
          `It has ${zones.map((zone) => zone.name).join(', ')}.`,
      );
    }
  }

  // The zone is the App's and the reach is each Component's, so a pin has to
  // be able to serve all of them — an App whose web is public and whose admin
  // is private is one App with two boundaries under it.
  const placements = await placementsFor(context.db, app.id);

  if (input.zone !== null) {
    // A Component core does not mint for takes its name from the platform, so
    // the pin only reaches its vanity label — which lands in the pinned zone
    // whatever the reach. Only the minted ones can be pushed off the pin.
    const displaced = placements.filter(
      (placement) =>
        coreMintsCanonical(placement.adapter) &&
        placement.reach !== 'none' &&
        zoneFor(placement.reach, zones, input.zone) !== input.zone,
    );
    if (displaced.length > 0) {
      const serves = zones
        .find((zone) => zone.name === input.zone)
        ?.reaches.join(' and ');
      return failed(
        'NOT_DEPLOYABLE',
        `${input.zone} serves ${serves}, and ` +
          `${displaced.map((one) => `${app.name}'s ${one.component} on ${targetLabel(one)} is ${one.reach}`).join('; ')}. ` +
          `Minting there would publish a record on a boundary ${input.zone} does not answer on, ` +
          'so pick a zone that serves every reach this App asks for, or change the reach first.',
      );
    }
  }

  await context.db
    .update(apps)
    .set({ zone: input.zone, updatedAt: context.clock.now() })
    .where(eq(apps.id, app.id));

  return ok({
    appId: app.id,
    zone: input.zone,
    hostnames: placements.flatMap((placement) =>
      namesUnder(app.name, placement, zones, input.zone),
    ),
  });
};
