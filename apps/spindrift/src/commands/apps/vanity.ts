/**
 * `setAppVanity`: sets the App's vanity name, one DNS label or `@` for the zone
 * apex, or clears it. Which Deploy carries it is the reconciler's decision.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps } from '../../db/schema.ts';
import {
  installationHostnames,
  isVanityLabel,
  ownHostnameClaimedBy,
} from '../../domain/naming.ts';
import { type Command, failed, ok } from '../types.ts';
import { namesUnder, placementsFor } from './names.ts';

export const setAppVanityInput = z
  .object({
    appId: z.uuid(),
    /** A DNS label, `@` for the zone apex, or `null` for no vanity name. */
    label: z.string().trim().nullable(),
  })
  .strict();

export type SetAppVanityInput = z.infer<typeof setAppVanityInput>;

export interface SetAppVanityResult {
  readonly appId: string;
  readonly vanity: string | null;
  /** The names this App's placed Components will answer on after this. */
  readonly hostnames: readonly string[];
}

export const setAppVanity: Command<
  SetAppVanityInput,
  SetAppVanityResult
> = async (input, context) => {
  const [app] = await context.db
    .select({ id: apps.id, name: apps.name, zone: apps.zone })
    .from(apps)
    .where(eq(apps.id, input.appId))
    .limit(1);
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  if (input.label !== null && !isVanityLabel(input.label)) {
    const rule =
      'must be a single lowercase DNS label, or @ for the zone itself';
    return failed('INVALID_INPUT', `'${input.label}' ${rule}`, [
      { path: 'label', message: rule },
    ]);
  }

  // An App's exact-hostname route outranks the control plane's at the gateway,
  // so a label that mints one of its names would take that name's traffic.
  const taken =
    input.label === null
      ? null
      : ownHostnameClaimedBy(
          input.label,
          context.manifest.dns.zones,
          installationHostnames(context.manifest.controlPlane),
        );
  if (taken !== null) {
    const rule = `would take ${taken}, which this installation reserves`;
    return failed('INVALID_INPUT', `'${input.label}' ${rule}`, [
      { path: 'label', message: rule },
    ]);
  }

  const placements = await placementsFor(context.db, app.id);

  await context.db
    .update(apps)
    .set({ vanityDomain: input.label, updatedAt: context.clock.now() })
    .where(eq(apps.id, app.id));

  return ok({
    appId: app.id,
    vanity: input.label,
    hostnames: placements.flatMap((placement) =>
      namesUnder(
        app.name,
        placement,
        context.manifest.dns.zones,
        app.zone,
        input.label,
      ),
    ),
  });
};
