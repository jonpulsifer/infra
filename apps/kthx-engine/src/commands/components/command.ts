/**
 * Sets the command and args a Component runs its image with. Both are required,
 * so args never outlive the command they were written for.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { components } from '../../db/schema.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { type Command, failed, ok } from '../types.ts';

/**
 * Refused empty: Cloud Run reads an empty command as no command, not the
 * image's own.
 */
export const argv = z.array(z.string().min(1)).min(1);

export const setComponentCommandInput = z
  .object({
    componentId: z.uuid(),
    /** `null` for the image's own. */
    command: argv.nullable(),
    /** `null` for the image's own. */
    args: argv.nullable(),
  })
  .strict();

export type SetComponentCommandInput = z.infer<typeof setComponentCommandInput>;

export interface SetComponentCommandResult {
  readonly componentId: string;
  readonly command: readonly string[] | null;
  readonly args: readonly string[] | null;
  /**
   * Targets whose live release pins a different entrypoint, as
   * `<vessel>/<adapter>`, sorted. Each picks the change up on its next Deploy.
   */
  readonly pendingRelease: readonly string[];
}

export const setComponentCommand: Command<
  SetComponentCommandInput,
  SetComponentCommandResult
> = async (input, context) => {
  // Written and read back in one statement, so the row cannot change in between.
  // Not gated on `kind`: every Component has an entrypoint.
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
    // A null `desiredDeploy` is a pair whose first attempt was vetoed, so nothing
    // runs there.
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
 * Order and length matter. Absent, in an older `desired` document, and `null`
 * both mean the image's own.
 */
function sameArgv(
  pinned: readonly string[] | undefined,
  asked: readonly string[] | null,
): boolean {
  return JSON.stringify(pinned ?? null) === JSON.stringify(asked);
}
