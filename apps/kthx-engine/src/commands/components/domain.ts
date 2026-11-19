/**
 * `setComponentDomain`: sets a Component's pinned zone and vanity label as one
 * act, checked against the names both together mint. Either both are written
 * or neither is. The next Deploy publishes the record.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { heldNames, vanity, zoneFor } from '../../domain/naming.ts';
import { kthxNamesOf, reserveForEdit } from '../apps/kthx-names.ts';
import {
  componentNaming,
  holderLabel,
  nameClash,
  namesUnder,
  placementsFor,
  withNamingLock,
} from '../apps/names.ts';
import { type Command, failed, ok } from '../types.ts';
import { labelRule } from './vanity.ts';
import { zonePinRefusal } from './zone.ts';

export const setComponentDomainInput = z
  .object({
    componentId: z.uuid(),
    /** The zone to mint in, or null for the first zone serving the reach. */
    zone: z.string().trim().min(1).nullable(),
    /** A DNS label, `@` for the zone apex, or `null` for no vanity name. */
    label: z.string().trim().nullable(),
  })
  .strict();

export type SetComponentDomainInput = z.infer<typeof setComponentDomainInput>;

export interface SetComponentDomainResult {
  readonly componentId: string;
  readonly zone: string | null;
  readonly vanity: string | null;
  /** The names this Component's placements will answer on after this. */
  readonly hostnames: readonly string[];
}

export const setComponentDomain: Command<
  SetComponentDomainInput,
  SetComponentDomainResult
> = (input, context) =>
  withNamingLock(context, (locked) => setDomain(input, locked));

const setDomain: Command<
  SetComponentDomainInput,
  SetComponentDomainResult
> = async (input, context) => {
  const subject = await componentNaming(context.db, input.componentId);
  if (subject === null) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  const zones = context.manifest.dns.zones;
  const pinRefused = zonePinRefusal<SetComponentDomainResult>(
    subject,
    input.zone,
    zones,
  );
  if (pinRefused !== null) return pinRefused;

  const rule = labelRule(subject, input.label, context.manifest);
  if (rule !== null) {
    return failed('INVALID_INPUT', `'${input.label}' ${rule}`, [
      { path: 'label', message: rule },
    ]);
  }

  const clash = await nameClash(
    context.db,
    zones,
    subject.id,
    heldNames({
      ...subject,
      zones,
      zone: input.zone,
      vanityLabel: input.label,
    }),
  );
  if (clash !== null) {
    const zone = zoneFor(subject.reach, zones, input.zone);
    const onLabel =
      input.label !== null &&
      zone !== null &&
      vanity(input.label, zone).toLowerCase() === clash.name;
    const rule = `would take ${clash.name}, which ${holderLabel(clash.holder)} holds`;
    return failed('INVALID_INPUT', rule, [
      { path: onLabel ? 'label' : 'zone', message: rule },
    ]);
  }

  const placements = (await placementsFor(context.db, subject.appId)).filter(
    (placement) => placement.componentId === subject.id,
  );

  const kthx = context.adapters.kthx?.() ?? null;
  if (kthx !== null) {
    const refused = await reserveForEdit<SetComponentDomainResult>(
      kthx,
      subject.appId,
      kthxNamesOf(
        subject.app,
        placements,
        zones,
        input.zone,
        input.label,
        kthx.zone,
      ),
      input.label === null
        ? {
            path: 'zone',
            subject:
              input.zone === null ? 'the default zone' : `'${input.zone}'`,
          }
        : { path: 'label', subject: `'${input.label}'` },
    );
    if (refused !== null) return refused;
  }

  await context.db
    .update(components)
    .set({
      zone: input.zone,
      vanityLabel: input.label,
      updatedAt: context.clock.now(),
    })
    .where(eq(components.id, subject.id));

  return ok({
    componentId: subject.id,
    zone: input.zone,
    vanity: input.label,
    hostnames: placements.flatMap((placement) =>
      namesUnder(subject.app, placement, zones, input.zone, input.label),
    ),
  });
};
