/**
 * `saveFunction` — upsert the row, then deploy inline to its target.
 *
 * **A deploy failure is data on the row, not a command failure.** Save is one
 * act with two halves — write the source, then try to make it live — and the
 * first always succeeds once the input validates. So the deploy's outcome
 * lands on `url`/`deployedAt`/`error` and the command still answers `ok`; only
 * a target this installation cannot reach at all (`context.adapters.functions`
 * has no deployer for it) is a refusal, because that is a fact about the
 * request rather than the deploy attempt.
 *
 * **The environment is merged, not replaced.** `env` carries one Save's
 * changes — a string sets a name, `null` deletes it, an absent name is left
 * alone — because the browser never holds the saved values and so cannot send
 * the whole map back. The merged map is sealed onto the row and handed to the
 * deploy; an installation with no keyring is refused before anything is
 * written rather than keeping values in the clear.
 *
 * **A target switch tears the old surface down first.** Two live deploys of
 * one name — the old target still answering while the new one comes up — is
 * a name the operator no longer controls from this row, so the old deployer's
 * `remove` runs before the new `deploy` does. Best effort: its failure joins
 * the new attempt's `error` rather than blocking the save the operator asked
 * for.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FunctionRow } from '../../db/schema.ts';
import { functions } from '../../db/schema.ts';
import {
  ENV_NAME_PATTERN,
  FUNCTION_NAME_PATTERN,
  FUNCTION_TARGETS,
  type FunctionEnv,
  type FunctionTarget,
  RESERVED_FUNCTION_NAMES,
} from '../../functions/contract.ts';
import { mergeEnv } from '../../functions/env.ts';
import { type Command, failed, ok } from '../types.ts';
import type { FunctionDetail } from '../views.ts';

export const saveFunctionInput = z
  .object({
    name: z
      .string()
      .regex(FUNCTION_NAME_PATTERN)
      .refine((name) => !RESERVED_FUNCTION_NAMES.has(name), {
        message: 'that name is reserved',
      }),
    target: z.enum(FUNCTION_TARGETS),
    source: z.string().min(1).max(1_000_000),
    /** One Save's changes: a string sets, `null` deletes, absent keeps. */
    env: z
      .record(
        z.string().regex(ENV_NAME_PATTERN),
        z.string().max(4_096).nullable(),
      )
      .default({}),
  })
  .strict();

export type SaveFunctionInput = z.infer<typeof saveFunctionInput>;

export interface SaveFunctionResult {
  readonly function: FunctionDetail;
}

export const saveFunction: Command<
  SaveFunctionInput,
  SaveFunctionResult
> = async (input, context) => {
  const now = context.clock.now();
  const existing = await context.db.query.functions.findFirst({
    where: (rows, { eq }) => eq(rows.name, input.name),
  });

  // Without a keyring there is nothing to open an existing envelope with, and
  // a merge seeded from `{}` would write `null` over it and redeploy with no
  // environment — a silent loss on both the row and the live function. So an
  // envelope this process cannot open is refused before anything is written,
  // whatever the request asked to change.
  const sealer = context.adapters.functionEnv?.() ?? null;
  if (sealer === null && existing?.env != null) {
    return failed(
      'NOT_DEPLOYABLE',
      'set SPINDRIFT_CREDENTIAL_KEYRING before a Function with saved environment values can be changed',
    );
  }
  const env = mergeEnv(
    sealer === null ? {} : await sealer.open(existing?.env ?? null),
    input.env,
  );
  if (Object.keys(env).length > 0 && sealer === null) {
    return failed(
      'NOT_DEPLOYABLE',
      'set SPINDRIFT_CREDENTIAL_KEYRING before a Function can keep environment values',
    );
  }
  const sealed =
    sealer === null || Object.keys(env).length === 0
      ? null
      : await sealer.seal(env);

  const saved =
    existing === undefined
      ? (
          await context.db
            .insert(functions)
            .values({
              name: input.name,
              target: input.target,
              source: input.source,
              env: sealed,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        )[0]!
      : (
          await context.db
            .update(functions)
            .set({
              target: input.target,
              source: input.source,
              env: sealed,
              updatedAt: now,
            })
            .where(eq(functions.id, existing.id))
            .returning()
        )[0]!;

  const deployers = context.adapters.functions?.() ?? null;
  const deployer = deployers?.[input.target] ?? null;
  if (deployer === null) {
    return failed(
      'NOT_DEPLOYABLE',
      `this installation has no ${input.target} surface to deploy to`,
    );
  }

  let removeError: string | null = null;
  if (existing !== undefined && existing.target !== input.target) {
    const previous = deployers?.[existing.target as FunctionTarget] ?? null;
    if (previous !== null) {
      try {
        await previous.remove(existing.name);
      } catch (cause) {
        removeError = cause instanceof Error ? cause.message : String(cause);
      }
    }
  }

  try {
    const { url } = await deployer.deploy(input.name, input.source, env);
    const [deployed] = await context.db
      .update(functions)
      .set({ url, deployedAt: now, error: null, updatedAt: now })
      .where(eq(functions.id, saved.id))
      .returning();
    return ok({ function: viewOf(deployed!, env) });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const [errored] = await context.db
      .update(functions)
      .set({
        error: removeError === null ? message : `${removeError}; ${message}`,
        updatedAt: now,
      })
      .where(eq(functions.id, saved.id))
      .returning();
    return ok({ function: viewOf(errored!, env) });
  }
};

function viewOf(row: FunctionRow, env: FunctionEnv): FunctionDetail {
  return {
    id: row.id,
    name: row.name,
    target: row.target as FunctionTarget,
    url: row.url,
    deployedAt: row.deployedAt?.toISOString() ?? null,
    error: row.error,
    updatedAt: row.updatedAt.toISOString(),
    source: row.source,
    envKeys: Object.keys(env),
  };
}
