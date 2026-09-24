/**
 * Declares the secrets a Component@Target's builds may read, as BuildKit secret
 * mounts in no layer or log. Core resolves them at dispatch, so no builder holds
 * a store credential. A change reaches the next build; no Deploy follows.
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
    entries: z.array(buildSecretEntry).optional(),
    removals: z
      .array(
        z.string().regex(VARIABLE_NAME, 'must be an environment variable name'),
      )
      .optional(),
  })
  .strict();

export type SetBuildSecretsInput = z.infer<typeof setBuildSecretsInput>;

/** Names only, never values. */
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

  // One key, one kind: a config entry of the same name is refused, never converted.
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
 * Like `configSubject`, but every kind needs a store, a website included, and
 * the store must have a read path for dispatch.
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
    // A website: `configSubject` skipped the store, so resolve it here.
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

/** The resolved values, or the sentence dispatch refuses with. */
export type ResolvedBuildSecrets =
  | { readonly secrets: readonly { name: string; value: string }[] }
  | { readonly refusal: string };

/**
 * Every failure is a refusal sentence, never a throw, because an operator can
 * fix each one before a later dispatch tick.
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
