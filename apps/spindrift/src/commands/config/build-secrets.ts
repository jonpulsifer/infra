/**
 * `setBuildSecrets` — declare the secrets one Component@Target's *builds* may
 * read (story 112).
 *
 * A build secret is a credential genuinely needed during a build and genuinely
 * absent from its output — a private package token being the ordinary case. It
 * reaches the builder as a BuildKit secret mount: on the filesystem for one
 * `RUN`, in no layer, no build log, and no baked value. §4's
 * `buildArgs` rule ("whatever a website bakes becomes public anyway") is an
 * argument about values that get baked, and a `--mount=type=secret` is defined
 * by not being one — so this is the gap that rule does not cover, closed the
 * way its second half demands: the value is written to §10's store here and
 * resolved by core at dispatch, so no builder ever holds a credential *to the
 * store*.
 *
 * **A separate list, not a flag on runtime config.** Four things differ and
 * the fourth is decisive: a different actor resolves it (core at dispatch, not
 * the platform's operator at apply), a different clock (a rotation reaches the
 * next build, never a running pod), a different failure (a dispatch refusal,
 * not a pod that will not start) — and the sets are *meant* to differ, because
 * the whole point is a credential the runtime must not hold. That is also why
 * one key cannot be both: the row is unique per (Component, Target, key), and
 * a call that would silently convert one kind into the other is refused with
 * the sentence instead.
 *
 * **No Deploy follows.** Rotating a build secret changes nothing until the
 * next build, and saying so is the honest answer — the mirror of what `set`
 * says for a website's baked value.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { SecretStore } from '../../adapters/store/contract.ts';
import { configItems, PINNED_ENVIRONMENT } from '../../db/schema.ts';
import { VARIABLE_NAME } from '../../domain/config.ts';
import { targetRowLabel } from '../../domain/target.ts';
import {
  type Command,
  type CommandContext,
  type CommandFailure,
  failed,
  ok,
} from '../types.ts';
import {
  auditConfigChange,
  type ConfigSubject,
  configSubject,
  reapKey,
  storeOfRecordOf,
} from './set.ts';

const buildSecretEntry = z
  .object({
    key: z
      .string()
      .regex(VARIABLE_NAME, 'must be an environment variable name'),
    value: z.string(),
  })
  .strict();

export const setBuildSecretsInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /** Absent or empty on a call that only removes. */
    entries: z.array(buildSecretEntry).optional(),
    removals: z
      .array(
        z.string().regex(VARIABLE_NAME, 'must be an environment variable name'),
      )
      .optional(),
  })
  .strict();

export type SetBuildSecretsInput = z.infer<typeof setBuildSecretsInput>;

/** Names only, the same posture every config result takes. */
export interface BuildSecretsResult {
  readonly componentId: string;
  readonly targetId: string;
  readonly written: readonly string[];
  readonly removed: readonly string[];
  /** Every build secret now declared for this pair, sorted. */
  readonly declared: readonly string[];
}

export const setBuildSecrets: Command<
  SetBuildSecretsInput,
  BuildSecretsResult
> = async (input, context) => {
  const entries = input.entries ?? [];
  const removals = input.removals ?? [];
  if (entries.length === 0 && removals.length === 0) {
    return failed('INVALID_INPUT', 'nothing to set or remove');
  }

  const duplicate = entries
    .map((entry) => entry.key)
    .find((key, index, keys) => keys.indexOf(key) !== index);
  if (duplicate !== undefined) {
    return failed(
      'INVALID_INPUT',
      `${duplicate} appears twice — one secret per variable (§10), so one value per key`,
    );
  }
  const contested = entries
    .map((entry) => entry.key)
    .find((key) => removals.includes(key));
  if (contested !== undefined) {
    return failed(
      'INVALID_INPUT',
      `${contested} is both set and removed in the same call`,
    );
  }

  const subject = await buildSecretSubject(context, input);
  if ('failure' in subject) return { ok: false, failure: subject.failure };
  const { store } = subject;

  // One key, one kind. A runtime variable of the same name is not updated —
  // it is the mistake this list exists to prevent, said out loud.
  const keys = [...entries.map((entry) => entry.key), ...removals];
  const existing = await context.db
    .select({ key: configItems.key, kind: configItems.kind })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, subject.componentId),
        eq(configItems.targetId, subject.targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        inArray(configItems.key, keys),
      ),
    );
  const crossed = existing.find((row) => row.kind !== 'build_secret');
  if (crossed !== undefined) {
    return failed(
      'INVALID_INPUT',
      `${crossed.key} is already ${
        crossed.kind === 'plain' ? 'build-time config' : 'runtime config'
      } on this pair — a build secret is a separate list, so remove the ` +
        'config entry first if this key is meant to move',
    );
  }

  const now = context.clock.now();
  const written: string[] = [];
  for (const entry of entries) {
    const reference = await store.put(subject.scope, entry.key, entry.value);
    await context.db
      .insert(configItems)
      .values({
        componentId: subject.componentId,
        targetId: subject.targetId,
        environment: PINNED_ENVIRONMENT,
        key: entry.key,
        kind: 'build_secret',
        storeRef: reference.key,
        storeVersion: reference.version,
        plainValue: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          configItems.componentId,
          configItems.targetId,
          configItems.environment,
          configItems.key,
        ],
        set: {
          kind: 'build_secret',
          storeRef: reference.key,
          storeVersion: reference.version,
          plainValue: null,
          updatedAt: now,
        },
      });
    written.push(entry.key);
    await auditConfigChange(context, subject, entry.key, 'set', now);
  }

  for (const key of removals) {
    await context.db
      .delete(configItems)
      .where(
        and(
          eq(configItems.componentId, subject.componentId),
          eq(configItems.targetId, subject.targetId),
          eq(configItems.environment, PINNED_ENVIRONMENT),
          eq(configItems.key, key),
        ),
      );
    await auditConfigChange(context, subject, key, 'removed', now);
  }

  for (const key of [...written, ...removals]) {
    await reapKey(subject, key);
  }

  return ok({
    componentId: subject.componentId,
    targetId: subject.targetId,
    written: [...written].sort(),
    removed: [...removals].sort(),
    declared: await declaredBuildSecrets(
      context,
      subject.componentId,
      subject.targetId,
    ),
  });
};

/**
 * Like `configSubject`, with the two differences a build secret carries: the
 * store is required whatever the Component's kind — a website's *runtime*
 * config is baked and needs no store, but its build can still need a private
 * token — and the store must be one dispatch can read back, because a value
 * nothing can resolve is a build that will be refused every tick.
 */
async function buildSecretSubject(
  context: CommandContext,
  input: { componentId: string; targetId: string },
): Promise<
  | (Omit<ConfigSubject, 'store'> & { store: SecretStore })
  | { failure: CommandFailure }
> {
  const subject = await configSubject(context, input);
  if ('failure' in subject) return subject;

  let store = subject.store;
  if (store === null) {
    // A website: `configSubject` skipped the store on purpose. Resolve it the
    // way it would have for anything else, and refuse where there is none.
    const target = await context.db.query.targets.findFirst({
      where: (targets, { eq }) => eq(targets.id, input.targetId),
      with: { vessel: true },
    });
    const adapter = target ? storeOfRecordOf(context, target) : null;
    store = adapter === null ? null : context.adapters.store(adapter);
    if (store === null) {
      return {
        failure: {
          code: 'NOT_DEPLOYABLE',
          message: `${target ? targetRowLabel(target) : 'this Target'} reaches no secret store this installation can write to, so a build secret set here could never reach a build`,
        },
      };
    }
  }

  if (store.open === undefined) {
    return {
      failure: {
        code: 'NOT_DEPLOYABLE',
        message: `the ${store.adapter} store cannot be read back at dispatch, so a build secret written to it would refuse every build that needs it — hold build secrets in a store with a read path`,
      },
    };
  }

  return { ...subject, store };
}

/**
 * What dispatch learns about one pair's build secrets: the resolved values, or
 * the sentence to refuse with.
 */
export type ResolvedBuildSecrets =
  | { readonly secrets: readonly { name: string; value: string }[] }
  | { readonly refusal: string };

/**
 * Resolve one pair's declared build secrets against §10's store — the one
 * caller `SecretStore.open` exists for.
 *
 * Every failure is a sentence rather than a throw, because each is a state an
 * operator can fix — re-set the secret, connect the store — and dispatch's
 * refusal-that-waits is the shape that makes the next tick work.
 */
export async function resolveBuildSecrets(
  context: Pick<CommandContext, 'db' | 'manifest' | 'adapters'>,
  componentId: string,
  targetId: string,
): Promise<ResolvedBuildSecrets> {
  const rows = await context.db
    .select({
      key: configItems.key,
      storeRef: configItems.storeRef,
      storeVersion: configItems.storeVersion,
    })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'build_secret'),
      ),
    );
  if (rows.length === 0) return { secrets: [] };

  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, targetId),
    with: { vessel: true },
  });
  const adapter = target ? storeOfRecordOf(context, target) : null;
  const store = adapter === null ? null : context.adapters.store(adapter);
  if (store === null) {
    return {
      refusal:
        'this Component declares build secrets, and its Target no longer reaches a secret store this installation can open — connect the store they were written to, or remove the declarations',
    };
  }
  if (store.open === undefined) {
    return {
      refusal: `this Component declares build secrets in the ${store.adapter} store, which cannot be read back at dispatch — hold them in a store with a read path, or remove the declarations`,
    };
  }

  const secrets: { name: string; value: string }[] = [];
  for (const row of rows.sort((a, b) => a.key.localeCompare(b.key))) {
    if (row.storeRef === null || row.storeVersion === null) {
      return {
        refusal: `build secret ${row.key} pins no store version — set it again`,
      };
    }
    const value = await store.open({
      key: row.storeRef,
      version: row.storeVersion,
    });
    if (value === null) {
      return {
        refusal: `build secret ${row.key} no longer resolves in the ${store.adapter} store — its pinned version is gone, so set it again`,
      };
    }
    secrets.push({ name: row.key, value });
  }
  return { secrets };
}

/** Every build secret declared for one pair, names only, sorted. */
export async function declaredBuildSecrets(
  context: Pick<CommandContext, 'db'>,
  componentId: string,
  targetId: string,
): Promise<string[]> {
  const rows = await context.db
    .select({ key: configItems.key })
    .from(configItems)
    .where(
      and(
        eq(configItems.componentId, componentId),
        eq(configItems.targetId, targetId),
        eq(configItems.environment, PINNED_ENVIRONMENT),
        eq(configItems.kind, 'build_secret'),
      ),
    );
  return rows.map((row) => row.key).sort();
}
