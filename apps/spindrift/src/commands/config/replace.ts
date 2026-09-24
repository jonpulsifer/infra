/**
 * Replaces a Component@Target's whole config from a bulk paste. The default call
 * only reviews. The diff is over keys, because core cannot read stored values.
 */
import { z } from 'zod';
import { VARIABLE_NAME } from '../../domain/config.ts';
import { type Command, failed, ok } from '../types.ts';
import {
  applyConfigChange,
  type ConfigChangeResult,
  configSubject,
  configuredKeys,
} from './set.ts';

export const replaceConfigInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /** The whole configuration, not a patch. An empty array clears every variable. */
    entries: z.array(
      z
        .object({
          key: z
            .string()
            .regex(VARIABLE_NAME, 'must be an environment variable name'),
          value: z.string(),
        })
        .strict(),
    ),
    /**
     * False, the default, reviews and writes nothing. The confirming call
     * recomputes the diff from the rows as they are then.
     */
    confirm: z.boolean().default(false),
  })
  .strict();

export type ReplaceConfigInput = z.infer<typeof replaceConfigInput>;

export interface ConfigDiff {
  readonly added: readonly string[];
  /** Rewritten regardless, because core cannot compare values it cannot read. */
  readonly rewritten: readonly string[];
  readonly removed: readonly string[];
}

export type ReplaceConfigResult =
  | ({ readonly applied: false } & ConfigDiff)
  | ({ readonly applied: true } & ConfigChangeResult);

export const replaceConfig: Command<
  ReplaceConfigInput,
  ReplaceConfigResult
> = async (input, context) => {
  const subject = await configSubject(context, input);
  if ('failure' in subject) return { ok: false, failure: subject.failure };

  const supplied = new Map<string, string>();
  for (const entry of input.entries) {
    if (supplied.has(entry.key)) {
      return failed(
        'INVALID_INPUT',
        `${entry.key} appears twice — one secret per variable (§10), so one value per key`,
      );
    }
    supplied.set(entry.key, entry.value);
  }

  const existing = new Set(
    await configuredKeys(context.db, subject.componentId, subject.targetId),
  );
  const diff: ConfigDiff = {
    added: [...supplied.keys()].filter((key) => !existing.has(key)).sort(),
    rewritten: [...supplied.keys()].filter((key) => existing.has(key)).sort(),
    removed: [...existing].filter((key) => !supplied.has(key)).sort(),
  };

  if (!input.confirm) {
    return ok({ applied: false, ...diff });
  }

  const applied = await applyConfigChange(
    context,
    subject,
    [...supplied].map(([key, value]) => ({ key, value })),
    diff.removed,
  );
  if (!applied.ok) return applied;
  return ok({ applied: true, ...applied.value });
};
