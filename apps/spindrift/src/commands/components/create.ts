/**
 * `createComponent` — the second half of §2's authored surface.
 *
 * §2: "one App to many Components", and the two fields that look like they want
 * to be kinds are not:
 *
 * > `schedule` is a field on a job, not a kind. `expose` is a field on a
 * > service.
 *
 * So this command takes one flat input with two conditional fields, and the
 * schema — not the handler — is what refuses `schedule` on a service. A field
 * that belongs to one kind arriving on another is malformed input, not a domain
 * decision, and putting the refusal in the schema is what keeps it out of both
 * the handler and every caller.
 *
 * **`website` is not a chart branch** (§7 renders it as a service with `expose`
 * forced) but it *is* a kind here, because §3 lets placement choose its artifact
 * shape and a website is the one kind that can land on either.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps, components } from '../../db/schema.ts';
import { AUTH_NEEDS_A_ROUTE } from '../../domain/desired-state.ts';
import { type Command, failed, ok } from '../types.ts';

/** A DNS-safe label: a Component's name appears in canonical hostnames (§9). */
const componentName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

/**
 * A five-field cron expression.
 *
 * Validated for shape and nothing more. Core never evaluates a schedule — §7's
 * chart renders a `CronJob` and the platform's own cron does the rest — so a
 * parser here would be a second implementation of something core does not run,
 * and the two would eventually disagree about a Sunday.
 */
const cronExpression = z
  .string()
  .trim()
  .regex(
    /^(\S+\s+){4}\S+$/,
    'must be a five-field cron expression, e.g. "0 3 * * *"',
  );

const common = {
  appId: z.uuid(),
  name: componentName,
  /**
   * §9: "`Private` is the default." Stated as a schema default rather than a
   * column default so a caller reading the input type sees which state they get
   * by saying nothing.
   */
  reach: z.enum(['none', 'private', 'public']).default('private'),
  auth: z.enum(['none', 'proxy']).default('proxy'),
};

export const createComponentInput = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('service'),
        /** §2: "an unexposed service is a queue worker." */
        expose: z.boolean().default(true),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('website'),
      })
      .strict(),
    z
      .object({
        ...common,
        kind: z.literal('job'),
        /** Absent means unscheduled — §7 renders that as a suspended CronJob. */
        schedule: cronExpression.optional(),
      })
      .strict(),
  ])
  /**
   * §9's rule, at the only moment refusing it is free: a filter needs a route to
   * sit on. Every other cell of the reach/auth grid is expressible, including
   * the two the old three-state exposure could not say — an unauthenticated
   * address on your own network, and an authenticated public one.
   */
  .refine((input) => !(input.reach === 'none' && input.auth === 'proxy'), {
    error: AUTH_NEEDS_A_ROUTE,
    path: ['auth'],
  });

export type CreateComponentInput = z.infer<typeof createComponentInput>;

export interface CreateComponentResult {
  readonly componentId: string;
  readonly appId: string;
  readonly name: string;
  readonly kind: 'service' | 'website' | 'job';
}

export const createComponent: Command<
  CreateComponentInput,
  CreateComponentResult
> = async (input, context) => {
  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, input.appId));
  if (app === undefined) {
    return failed('NOT_FOUND', `there is no App with id ${input.appId}`);
  }

  const now = context.clock.now();

  const [row] = await context.db
    .insert(components)
    .values({
      appId: app.id,
      name: input.name,
      kind: input.kind,
      // §7: a website is "a service with `expose` forced and a fixed port", so
      // the value is not the developer's to set — it is what the kind means.
      expose: exposeFor(input),
      schedule: input.kind === 'job' ? (input.schedule ?? null) : null,
      reach: input.reach,
      auth: input.auth,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return ok({
    componentId: row!.id,
    appId: app.id,
    name: row!.name,
    kind: row!.kind,
  });
};

/**
 * `expose` per kind (§2, §7).
 *
 * Null for a job rather than false: a job does not serve, so it has no answer to
 * the question, and `false` would say it chose not to.
 */
function exposeFor(input: CreateComponentInput): boolean | null {
  switch (input.kind) {
    case 'service':
      return input.expose;
    case 'website':
      return true;
    case 'job':
      return null;
  }
}
