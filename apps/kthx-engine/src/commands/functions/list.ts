/**
 * `listFunctions` lists every Function by name. No pagination: Functions are
 * written by hand, tens per installation.
 */
import { z } from 'zod';
import { type Command, ok } from '../types.ts';
import type { FunctionListItem } from '../views.ts';

export const listFunctionsInput = z.object({}).strict();

export type ListFunctionsInput = z.infer<typeof listFunctionsInput>;

export interface ListFunctionsResult {
  readonly functions: readonly FunctionListItem[];
}

export const listFunctions: Command<
  ListFunctionsInput,
  ListFunctionsResult
> = async (_input, context) => {
  const rows = await context.db.query.functions.findMany({
    orderBy: (row, { asc }) => [asc(row.name)],
  });

  return ok({
    functions: rows.map((row) => ({
      id: row.id,
      name: row.name,
      target: row.target as FunctionListItem['target'],
      url: row.url,
      deployedAt: row.deployedAt?.toISOString() ?? null,
      error: row.error,
      updatedAt: row.updatedAt.toISOString(),
    })),
  });
};
