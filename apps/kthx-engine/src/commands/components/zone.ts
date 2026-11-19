/**
 * `setComponentZone`: pins the DNS zone a Component's names are minted in, or
 * clears the pin back to the first zone serving its reach. The next Deploy
 * publishes the record.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { heldNames, zoneServes } from '../../domain/naming.ts';
import { kthxNamesOf, reserveForEdit } from '../apps/kthx-names.ts';
import {
  componentNaming,
  holderLabel,
  nameClash,
  namesUnder,
  placementsFor,
  zoneReaches,
} from '../apps/names.ts';
import { type Command, failed, ok } from '../types.ts';

export const setComponentZoneInput = z
  .object({
    componentId: z.uuid(),
    /** The zone to mint in, or null for the first zone serving the reach. */
    zone: z.string().trim().min(1).nullable(),
  })
  .strict();

export type SetComponentZoneInput = z.infer<typeof setComponentZoneInput>;

export interface SetComponentZoneResult {
  readonly componentId: string;
  readonly zone: string | null;
  /** The names this Component's placements will answer on after this. */
  readonly hostnames: readonly string[];
}

export const setComponentZone: Command<
  SetComponentZoneInput,
  SetComponentZoneResult
> = async (input, context) => {
  const subject = await componentNaming(context.db, input.componentId);
  if (subject === null) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
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

  // `zoneFor` falls through when a pin cannot serve the reach, so the pin is
  // refused here instead of minting somewhere nobody chose.
  if (input.zone !== null && !zoneServes(input.zone, subject.reach, zones)) {
    const rule =
      `${input.zone} serves ${zoneReaches(input.zone, zones)}; ${holderLabel(subject)} is ${subject.reach}. ` +
      `Pick a zone that serves ${subject.reach}, or change the reach first.`;
    return failed('INVALID_INPUT', rule, [{ path: 'zone', message: rule }]);
  }

  const clash = await nameClash(
    context.db,
    zones,
    subject.id,
    heldNames({ ...subject, zones, zone: input.zone }),
  );
  if (clash !== null) {
    const rule = `would take ${clash.name}, which ${holderLabel(clash.holder)} holds`;
    const opening =
      input.zone === null ? 'the default zone' : `'${input.zone}'`;
    return failed('INVALID_INPUT', `${opening} ${rule}`, [
      { path: 'zone', message: rule },
    ]);
  }

  const placements = (await placementsFor(context.db, subject.appId)).filter(
    (placement) => placement.componentId === subject.id,
  );

  // Moving out of kthx's zone releases nothing: the live routes keep the old
  // names until the next Deploy, and only a delete releases.
  const kthx = context.adapters.kthx?.() ?? null;
  if (kthx !== null) {
    const refused = await reserveForEdit<SetComponentZoneResult>(
      kthx,
      subject.appId,
      kthxNamesOf(
        subject.app,
        placements,
        zones,
        input.zone,
        subject.vanityLabel,
        kthx.zone,
      ),
      {
        path: 'zone',
        subject: input.zone === null ? 'the default zone' : `'${input.zone}'`,
      },
    );
    if (refused !== null) return refused;
  }

  await context.db
    .update(components)
    .set({ zone: input.zone, updatedAt: context.clock.now() })
    .where(eq(components.id, subject.id));

  return ok({
    componentId: subject.id,
    zone: input.zone,
    hostnames: placements.flatMap((placement) =>
      namesUnder(
        subject.app,
        placement,
        zones,
        input.zone,
        subject.vanityLabel,
      ),
    ),
  });
};
