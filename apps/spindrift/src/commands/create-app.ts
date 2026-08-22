/**
 * `createApp` — the first of §2's two human-authored nouns.
 *
 * §2: "App <- authored, source = repo(url, subpath) | archive(upload),
 * immutable vessel reference, domain, config." The source is a discriminated
 * union in the input schema for the same reason it is two nullable column
 * pairs in the schema: an App has exactly one source, and a repo App with an
 * archive digest is not a state the domain has a name for.
 *
 * What this command deliberately does **not** do: create Components, detect a
 * kind, or place anything. §2's cardinality is one App to many Components, and
 * every one of those acts is its own command in a later milestone. Creating an
 * App writes one row and nothing else.
 */
import { z } from 'zod';
import { apps } from '../db/schema.ts';
import { digestSchema } from '../domain/digest.ts';
import { isVanityLabel } from '../domain/naming.ts';
import { type Command, ok } from './types.ts';

/** A DNS-safe label: the name appears in canonical hostnames (§9). */
const appName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

/** §9: "the flat single-label vanity name" — one label, or the zone itself. */
const vanityLabel = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .refine(
    isVanityLabel,
    'must be a single lowercase DNS label, or @ for the zone itself',
  );

/** A content digest of the uploaded bundle (§4: the bundle digest joins the receipt to its provenance). */
const archiveDigest = digestSchema;

/**
 * **No vessel input.** Creating an App does not choose a boundary: placement
 * does, one Component at a time, and the Target it picks is a surface on one.
 * An App-level vessel would be a second answer nothing reconciles against the
 * first.
 */
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
      /** §5: "the scope is named, never searched" — a subpath, not a scan. */
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

/**
 * What the caller learns. Narrow on purpose: the App row's shape is the data
 * layer's business, and a result that mirrored it would make every column a
 * promise to the UI.
 */
export interface CreateAppResult {
  readonly appId: string;
  readonly name: string;
  /** Stamped from the context clock, never from the database's `now()`. */
  readonly createdAt: Date;
}

/**
 * There is no duplicate-name refusal here, because there is no unique key on
 * `apps.name` to enforce one — inventing the rule in this handler alone would
 * put it exactly one concurrent request away from being false.
 */
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
