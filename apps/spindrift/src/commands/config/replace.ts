/**
 * `replaceConfig` — a bulk paste, reviewed before it lands (§10).
 *
 * §10: "**Uploads are replace-with-diff.**" Story 79 says what that buys: "so
 * that a bulk paste shows me what it is about to change". So this command has
 * two modes and the default is the review — an act that overwrites a
 * Component's whole configuration on the first call is one nobody can look at
 * before it happens.
 *
 * **The diff is over keys, and that is not a shortcut.** Core cannot read a
 * stored value back (§10), so it cannot tell a key whose value changed from a
 * key whose value is identical. Rather than pretend, the review names three
 * things it *can* be certain of:
 *
 * - `added` — a key that is not configured here yet.
 * - `removed` — a key that is configured here and is not in the upload. This is
 *   the half that makes a paste dangerous, and the half a review exists for.
 * - `rewritten` — a key in both. Every one of them gets a fresh pinned version,
 *   because "unchanged" is a claim only something that had read the old value
 *   could make.
 *
 * A rewrite that writes the same bytes again costs one store version and no
 * behaviour: the document changes, so a Deploy follows, and the workload comes
 * back up with what the developer just pasted. Guessing the other way — that a
 * value the developer supplied was already there — is how a paste silently does
 * nothing.
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
    /**
     * The whole configuration, not a patch. An empty array is a legal upload —
     * it is how a developer clears every variable — which is exactly why the
     * review is not optional.
     */
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
     * False — the default — reviews and writes nothing.
     *
     * The two calls are independent: the second re-reads what is configured and
     * recomputes what it is about to do, so a config change that landed between
     * them changes the second call's effect rather than being silently
     * overwritten by a plan made against stale rows.
     */
    confirm: z.boolean().default(false),
  })
  .strict();

export type ReplaceConfigInput = z.infer<typeof replaceConfigInput>;

/** What a paste is about to do, in keys — never in values (§10). */
export interface ConfigDiff {
  readonly added: readonly string[];
  /** In both. Rewritten regardless: core cannot compare values it cannot read. */
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
