/** `listAllDeploys` — the global artifact-placement ledger, newest first. */
import { z } from 'zod';
import { type Command, ok } from '../types.ts';
import type { DeployLedgerItem } from '../views.ts';
import { RELEASE_PAGE, releasesOf } from './list.ts';

export const listAllDeploysInput = z
  .object({
    limit: z.number().int().positive().max(RELEASE_PAGE).optional(),
    /** Return Deploys older than this id. */
    before: z.number().int().positive().optional(),
  })
  .strict();

export type ListAllDeploysInput = z.infer<typeof listAllDeploysInput>;

export interface ListAllDeploysResult {
  readonly deploys: readonly DeployLedgerItem[];
  readonly nextBefore: number | null;
}

export const listAllDeploys: Command<
  ListAllDeploysInput,
  ListAllDeploysResult
> = async (input, context) => {
  return ok(
    await releasesOf(context, null, input.limit ?? RELEASE_PAGE, input.before),
  );
};
