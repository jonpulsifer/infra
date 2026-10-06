/**
 * `runFunction` previews unsaved source in the sandbox with the saved
 * Function's environment, writing nothing. Functions are trusted-author, so the
 * sandbox stops a runaway loop, not a hostile author.
 */
import { z } from 'zod';
import type { PreviewResult } from '../../functions/contract.ts';
import { runPreview } from '../../functions/preview.ts';
import { type Command, ok } from '../types.ts';

export const runFunctionInput = z
  .object({
    /**
     * The saved Function whose environment this Run reads; without one, env is
     * empty.
     */
    name: z.string().optional(),
    source: z.string().min(1),
    request: z
      .object({
        method: z.string().default('GET'),
        path: z.string().default('/'),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type RunFunctionInput = z.infer<typeof runFunctionInput>;

export const runFunction: Command<RunFunctionInput, PreviewResult> = async (
  input,
  context,
) => {
  const name = input.name;
  const row =
    name === undefined
      ? undefined
      : await context.db.query.functions.findFirst({
          where: (rows, { eq }) => eq(rows.name, name),
        });
  const sealer = context.adapters.functionEnv?.() ?? null;
  const env =
    row === undefined || sealer === null ? {} : await sealer.open(row.env);

  return ok(await runPreview(input.source, input.request, { env }));
};
