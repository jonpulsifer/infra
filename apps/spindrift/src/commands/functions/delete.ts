/**
 * `deleteFunction` — remove a Function from its deploy target, then the row.
 *
 * The adapter call happens before the row is touched, following
 * `destroyDatastore`'s rule: a refused teardown leaves everything as it was,
 * and pressing the button again is the retry.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { functions } from '../../db/schema.ts';
import type { FunctionTarget } from '../../functions/contract.ts';
import { type Command, failed, ok } from '../types.ts';

export const deleteFunctionInput = z
  .object({
    name: z.string(),
  })
  .strict();

export type DeleteFunctionInput = z.infer<typeof deleteFunctionInput>;

export interface DeleteFunctionResult {
  readonly name: string;
}

export const deleteFunction: Command<
  DeleteFunctionInput,
  DeleteFunctionResult
> = async (input, context) => {
  const row = await context.db.query.functions.findFirst({
    where: (rows, { eq }) => eq(rows.name, input.name),
  });
  if (row === undefined) {
    return failed('NOT_FOUND', `there is no Function named '${input.name}'`);
  }

  const deployers = context.adapters.functions?.() ?? null;
  const deployer = deployers?.[row.target as FunctionTarget] ?? null;
  if (deployer === null) {
    return failed(
      'NOT_REMOVABLE',
      `this installation has no ${row.target} surface to remove '${row.name}' from`,
    );
  }

  try {
    await deployer.remove(row.name);
  } catch (cause) {
    return failed(
      'NOT_REMOVABLE',
      cause instanceof Error ? cause.message : String(cause),
    );
  }

  await context.db.delete(functions).where(eq(functions.id, row.id));

  return ok({ name: row.name });
};
