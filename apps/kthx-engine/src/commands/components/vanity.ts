/**
 * `setComponentVanity`: sets a Component's vanity name, one DNS label or `@`
 * for its zone's apex, or clears it. The next Deploy publishes the record.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import {
  installationHostnames,
  isVanityLabel,
  ownHostnameClaimedBy,
  servesNetwork,
  vanity,
  zoneFor,
} from '../../domain/naming.ts';
import { kthxNamesOf, reserveForEdit } from '../apps/kthx-names.ts';
import {
  componentNaming,
  holderLabel,
  nameClash,
  namesUnder,
  placementsFor,
} from '../apps/names.ts';
import { type Command, failed, ok } from '../types.ts';

export const setComponentVanityInput = z
  .object({
    componentId: z.uuid(),
    /** A DNS label, `@` for the zone apex, or `null` for no vanity name. */
    label: z.string().trim().nullable(),
  })
  .strict();

export type SetComponentVanityInput = z.infer<typeof setComponentVanityInput>;

export interface SetComponentVanityResult {
  readonly componentId: string;
  readonly vanity: string | null;
  /** The names this Component's placements will answer on after this. */
  readonly hostnames: readonly string[];
}

export const setComponentVanity: Command<
  SetComponentVanityInput,
  SetComponentVanityResult
> = async (input, context) => {
  const subject = await componentNaming(context.db, input.componentId);
  if (subject === null) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }
  const refuse = (rule: string) =>
    failed<SetComponentVanityResult>(
      'INVALID_INPUT',
      `'${input.label}' ${rule}`,
      [{ path: 'label', message: rule }],
    );

  if (input.label !== null && !isVanityLabel(input.label)) {
    return refuse(
      'must be a single lowercase DNS label, or @ for the zone itself',
    );
  }

  if (input.label !== null && !servesNetwork(subject)) {
    return refuse(
      `cannot name ${holderLabel(subject)}: only a website or an exposed service answers on a name of its own`,
    );
  }

  // A Component's exact-hostname route outranks the control plane's at the
  // gateway, so a label that mints one of its names would take that traffic.
  const zones = context.manifest.dns.zones;
  const taken =
    input.label === null
      ? null
      : ownHostnameClaimedBy(
          input.label,
          zones,
          installationHostnames(context.manifest.controlPlane),
        );
  if (taken !== null) {
    return refuse(`would take ${taken}, which this installation reserves`);
  }

  const zone = zoneFor(subject.reach, zones, subject.zone);
  if (input.label !== null && zone !== null) {
    const clash = await nameClash(context.db, zones, subject.id, [
      vanity(input.label, zone),
    ]);
    if (clash !== null) {
      return refuse(
        `would take ${clash.name}, which ${holderLabel(clash.holder)} holds`,
      );
    }
  }

  const placements = (await placementsFor(context.db, subject.appId)).filter(
    (placement) => placement.componentId === subject.id,
  );

  // Reserved before the write; a failed write leaves the names held by this
  // App, which only keeps them from a site. A clear mints no name, and the
  // deploy gate still holds the canonical ones.
  const kthx = context.adapters.kthx?.() ?? null;
  if (kthx !== null && input.label !== null) {
    const refused = await reserveForEdit<SetComponentVanityResult>(
      kthx,
      subject.appId,
      kthxNamesOf(
        subject.app,
        placements,
        zones,
        subject.zone,
        input.label,
        kthx.zone,
      ),
      { path: 'label', subject: `'${input.label}'` },
    );
    if (refused !== null) return refused;
  }

  await context.db
    .update(components)
    .set({ vanityLabel: input.label, updatedAt: context.clock.now() })
    .where(eq(components.id, subject.id));

  return ok({
    componentId: subject.id,
    vanity: input.label,
    hostnames: placements.flatMap((placement) =>
      namesUnder(subject.app, placement, zones, subject.zone, input.label),
    ),
  });
};
