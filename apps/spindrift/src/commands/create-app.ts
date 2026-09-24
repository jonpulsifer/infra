/**
 * Creates an App. It writes one row: Components, detection and placement are
 * separate commands.
 */
import { z } from 'zod';
import { apps } from '../db/schema.ts';
import { digestSchema } from '../domain/digest.ts';
import { isVanityLabel } from '../domain/naming.ts';
import { type Command, ok } from './types.ts';

/** A DNS label, because the name appears in canonical hostnames. */
const appName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

const vanityLabel = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .refine(
    isVanityLabel,
    'must be a single lowercase DNS label, or @ for the zone itself',
  );

const archiveDigest = digestSchema;

/** No vessel input: placement picks the boundary, one Component at a time. */
const common = {
  name: appName,
  vanityDomain: vanityLabel.optional(),
};

export const createAppInput = z.discriminatedUnion('sourceKind', [
  z
    .object({
      ...common,
      sourceKind: z.literal('repo'),
      repoUrl: z.url(),
      subpath: z.string().trim().min(1).optional(),
    })
    .strict(),
  z
    .object({
      ...common,
      sourceKind: z.literal('archive'),
      archiveDigest,
    })
    .strict(),
]);

export type CreateAppInput = z.infer<typeof createAppInput>;

export interface CreateAppResult {
  readonly appId: string;
  readonly name: string;
  /** From the context clock, never the database's `now()`. */
  readonly createdAt: Date;
}

/** No duplicate-name refusal: `apps.name` has no unique key to enforce it. */
export const createApp: Command<CreateAppInput, CreateAppResult> = async (
  input,
  context,
) => {
  const now = context.clock.now();

  const [row] = await context.db
    .insert(apps)
    .values({
      name: input.name,
      sourceKind: input.sourceKind,
      sourceRepoUrl: input.sourceKind === 'repo' ? input.repoUrl : null,
      sourceRepoSubpath:
        input.sourceKind === 'repo' ? (input.subpath ?? null) : null,
      sourceArchiveDigest:
        input.sourceKind === 'archive' ? input.archiveDigest : null,
      vanityDomain: input.vanityDomain ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return ok({
    appId: row!.id,
    name: row!.name,
    createdAt: row!.createdAt,
  });
};
