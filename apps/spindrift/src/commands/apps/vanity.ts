/**
 * `setAppVanity` — an App names its own flat, shared name (§9).
 *
 * §9's vanity name is one label or the apex, spelled `@` because a vanity name
 * is otherwise a label joined with a dot and the bare zone has no label to
 * join. It is the name every adapter now carries when the App has one
 * (`hostnameFor`, `naming.ts`) — `www` and the apex are the names a developer
 * actually shares, and a minted `<app>-<component>.<zone>` can never be
 * either of them, on a cluster Target no less than on any other.
 *
 * **One name, on the App, not the Component.** `deploy-loop.ts`'s rule — a
 * sole network-serving Component carries it, an App with two gets none — is
 * unchanged and unconsulted here: this command only writes the App's choice,
 * and what a given Deploy resolves it to is the reconciler's call, not this
 * one's.
 *
 * Clearing the choice is the same command with a null label, which drops the
 * App back to having no shared name — there is no installation default to
 * fall back to here, unlike `setAppZone`'s zone pin.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps } from '../../db/schema.ts';
import { isVanityLabel } from '../../domain/naming.ts';
import { type Command, failed, ok } from '../types.ts';
import { namesUnder, placementsFor } from './names.ts';

export const setAppVanityInput = z
  .object({
    appId: z.uuid(),
    /**
     * The label to mint as, `@` for the zone itself, or null to clear it.
     *
     * Nullable rather than optional: "leave it as it is" and "clear it" are
     * different acts and an absent key cannot mean both.
     */
    label: z.string().trim().nullable(),
  })
  .strict();

export type SetAppVanityInput = z.infer<typeof setAppVanityInput>;

export interface SetAppVanityResult {
  readonly appId: string;
  /** The App's vanity label after this, or null when it now has none. */
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
