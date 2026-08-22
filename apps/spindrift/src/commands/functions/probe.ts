/**
 * `probeFunction` — is a Function answering yet.
 *
 * A separate command from `getFunction` rather than a field on it: readiness
 * is not a row property, it is the answer to a `fetch` made right now, and a
 * screen that polls it wants exactly that call and nothing else the row read
 * would also do.
 */
import { z } from 'zod';
import type { FunctionProbe } from '../../functions/readiness.ts';
import { probeUrl } from '../../functions/readiness.ts';
import { type Command, failed, ok } from '../types.ts';

export const probeFunctionInput = z
  .object({
    name: z.string(),
  })
  .strict();

export type ProbeFunctionInput = z.infer<typeof probeFunctionInput>;

export type ProbeFunctionResult = FunctionProbe;

export const probeFunction: Command<
  ProbeFunctionInput,
  ProbeFunctionResult
> = async (input, context) => {
  const row = await context.db.query.functions.findFirst({
    where: (rows, { eq }) => eq(rows.name, input.name),
  });
  if (row === undefined) {
    return failed('NOT_FOUND', `there is no Function named '${input.name}'`);
  }

  if (row.url === null) {
    return ok({
      ready: false,
      detail: 'not deployed',
      checkedAt: context.clock.now().toISOString(),
    });
  }

  return ok(await probeUrl(row.url, { now: () => context.clock.now() }));
};
