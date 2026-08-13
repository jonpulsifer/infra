/**
 * `setComponentCommand` — change the entrypoint a Component runs its image
 * with, after creation (§2).
 *
 * This is what makes a monolith expressible: `web`, `worker` and `cleanup` are
 * one image run three ways, and the difference between them is this field and
 * nothing else. The chart has taken `app.command` and `app.args` since it was
 * written (`packages/charts/spindrift-app/values.yaml`), and Cloud Run's
 * container carries the same two fields — so nothing downstream had to change
 * to accept an entrypoint, only core had to start sending one.
 *
 * **This is a deploy, not a settings toggle**, for the reason
 * `setComponentReach` states: `createDeploy` pins the Component's shape into
 * `deploys.desired` when the intent is written, and `desiredStateFor` replays
 * that pinned document on every attempt rather than re-reading `components`.
 * So writing this row changes nothing that is currently running — the pods a
 * live release put up keep running the entrypoint that release was written
 * with until somebody presses Deploy. `pendingRelease` names where that is
 * still true.
 *
 * **Both fields are required, and `null` is how each is removed.** `createComponent`
 * states them at creation and may omit either, because a Component that has just
 * been written has nothing to leave alone. An edit has no such default to fall
 * back to, so an omitted field here would read as
 * "leave it alone" — and leaving half an entrypoint alone is the dangerous
 * half: `args` written for one binary silently surviving onto another is a
 * process started with flags it never declared. `command` and `args` are one
 * statement about how the image is run, so one act states all of it. `null`
 * on both is the image's own entrypoint, which is what every Component that
 * has never been edited already means.
 *
 * **Nothing here validates the command against the image.** Core does not read
 * image manifests and should not start; a wrong entrypoint is a
 * CrashLoopBackOff the diagnosis panel already explains.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

/**
 * One argv, or nothing.
 *
 * An empty list is refused rather than accepted and stored, because it is the
 * same statement as `null` said in a shape the rest of the system would then
 * have to keep telling apart: the Kubernetes chart's `with` skips it, Cloud Run
 * reads a rendered empty `command` as "run no command", and a pinned `[]` would
 * diff as different from a pinned absence while meaning the same thing. One
 * spelling for "the image's own", and it is `null`.
 */
export const argv = z.array(z.string().min(1)).min(1);

export const setComponentCommandInput = z
  .object({
    componentId: z.uuid(),
    /** The entrypoint to run, or `null` for the image's own. */
    command: argv.nullable(),
    /** The arguments to pass it, or `null` for the image's own. */
    args: argv.nullable(),
  })
  .strict();

export type SetComponentCommandInput = z.infer<typeof setComponentCommandInput>;

export interface SetComponentCommandResult {
  readonly componentId: string;
  readonly command: readonly string[] | null;
  readonly args: readonly string[] | null;
  /**
   * The Targets whose current release still runs the previous entrypoint, as
   * `<vessel>/<adapter>` and sorted.
   *
   * Narrowed the way `setComponentReach`'s is rather than left conservative
   * like `setComponentSchedule`'s, and for the reason that one gives: this is
   * read off the Deploy's **own pinned** `command`/`args`, which exist so that
   * "what is running" and "what is now asked for" can be different values. A
   * Target whose live release already runs what was just saved has nothing
   * pending, and saying it does would send an operator to press Deploy for a
   * release that changes nothing.
   */
  readonly pendingRelease: readonly string[];
}

export const setComponentCommand: Command<
  SetComponentCommandInput,
  SetComponentCommandResult
> = async (input, context) => {
  // Written and read back in one statement, as `setComponentReach` does: a
  // select, a decision and an update are three chances for the row to have
  // become a different row. Nothing here gates on `kind` — unlike `schedule`
  // and `expose`, an entrypoint belongs to every Component, and refusing one
  // on a job would be refusing exactly the monolith case this exists for.
  const [row] = await context.db
    .update(components)
    .set({
      command: input.command,
      args: input.args,
      updatedAt: context.clock.now(),
    })
    .where(eq(components.id, input.componentId))
    .returning();
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  const placed = await context.db.query.componentTargetDesired.findMany({
    where: (desired, { eq }) => eq(desired.componentId, row.id),
    with: {
      target: {
        columns: { adapter: true },
        with: { vessel: { columns: { name: true } } },
      },
      desiredDeploy: { columns: { desired: true } },
    },
  });

  return ok({
    componentId: row.id,
    command: row.command,
    args: row.args,
    // `desiredDeploy` null is a pair `createDeploy` inserted and then left
    // unreached because that first attempt was vetoed
    // (`src/commands/deploys/create.ts:185-211`): nothing is running there, so
    // nothing there is pending.
    pendingRelease: placed
      .filter(
        ({ desiredDeploy }) =>
          desiredDeploy !== null &&
          (!sameArgv(desiredDeploy.desired.command, input.command) ||
            !sameArgv(desiredDeploy.desired.args, input.args)),
      )
      .map(({ target }) => targetRowLabel(target))
      .sort(),
  });
};

/**
 * Whether a pinned argv and an asked-for one say the same thing.
 *
 * Order matters and length matters, so this is a list comparison and not a set
 * one. Serialised rather than looped because the two sides are the same jsonb
 * shape, and because absent (an old `desired` document, written before these
 * fields existed) and `null` (an entrypoint deliberately removed) are the same
 * statement — the image's own — so both have to normalize to one token before
 * anything is compared.
 */
function sameArgv(
  pinned: readonly string[] | undefined,
  asked: readonly string[] | null,
): boolean {
  return JSON.stringify(pinned ?? null) === JSON.stringify(asked);
}
