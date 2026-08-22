/**
 * `getFunction` — one Function's own screen: the ledger row plus its source.
 *
 * The environment comes back as key names only: the values are write-only, so
 * the envelope is opened to learn what is set and never to say what it holds.
 */
import { z } from 'zod';
import { type Command, failed, ok } from '../types.ts';
import type { FunctionDetail } from '../views.ts';

export const getFunctionInput = z
  .object({
    name: z.string(),
  })
  .strict();

export type GetFunctionInput = z.infer<typeof getFunctionInput>;

export interface GetFunctionResult {
  readonly function: FunctionDetail;
}

export const getFunction: Command<GetFunctionInput, GetFunctionResult> = async (
  input,
  context,
) => {
  const row = await context.db.query.functions.findFirst({
    where: (rows, { eq }) => eq(rows.name, input.name),
  });
  if (row === undefined) {
    return failed('NOT_FOUND', `there is no Function named '${input.name}'`);
  }

  const sealer = context.adapters.functionEnv?.() ?? null;
  const env = sealer === null ? {} : await sealer.open(row.env);

  return ok({
    function: {
      id: row.id,
      name: row.name,
      target: row.target as FunctionDetail['target'],
      url: row.url,
      deployedAt: row.deployedAt?.toISOString() ?? null,
      error: row.error,
      updatedAt: row.updatedAt.toISOString(),
      source: row.source,
      envKeys: Object.keys(env).sort(),
    },
  });
};
