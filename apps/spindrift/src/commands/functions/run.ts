/**
 * `runFunction` — preview a handler in the sandbox, with no row and no
 * deploy. `functions/contract.ts` admits Functions on a trusted-author
 * basis, so the preview stops a runaway loop, not a hostile author, and this
 * reaches no adapter at all.
 */
import { z } from 'zod';
import type { PreviewResult } from '../../functions/contract.ts';
import { runPreview } from '../../functions/preview.ts';
import { type Command, ok } from '../types.ts';

export const runFunctionInput = z
  .object({
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
  _context,
) => {
  return ok(await runPreview(input.source, input.request));
};
