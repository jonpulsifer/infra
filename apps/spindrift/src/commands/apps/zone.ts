/**
 * `setAppZone`: pins the DNS zone an App's names are minted in, or clears the
 * pin back to the installation default. The next Deploy publishes the record.
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
    /** The zone to mint in, or null for the installation's default. */
    zone: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetAppZoneInput = z.infer<typeof setAppZoneInput>;

export interface SetAppZoneResult {
  readonly appId: string;
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

  const placements = await placementsFor(context.db, app.id);

  if (input.zone !== null) {
    // `zoneFor` silently falls back when the pin cannot serve a reach, so the
    // pin is refused instead. Only names core mints are checked.
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
