/**
 * `runFunction` — preview a handler in the sandbox, with no row written and no
 * deploy. `functions/contract.ts` admits Functions on a trusted-author basis,
 * so the preview stops a runaway loop, not a hostile author.
 *
 * `name` is how a Run reaches the saved environment: the values are
 * write-only, so the browser cannot send them and the handler would otherwise
 * see an `env` the deployed function does not have. A name with no row — a
 * function being written for the first time — runs with an empty one.
 *
 * The source is the editor's, not the row's, on purpose: a Run exists to try
 * unsaved code against the real values before a Save. That hands the values
 * to whatever the operator wrote, which under v1's single trust level is the
 * person who set them — `functions/env.ts` says the same from the other side.
 */
import { z } from 'zod';
import type { PreviewResult } from '../../functions/contract.ts';
import { runPreview } from '../../functions/preview.ts';
import { type Command, ok } from '../types.ts';

export const runFunctionInput = z
  .object({
    /** The saved function whose environment this Run reads. */
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
