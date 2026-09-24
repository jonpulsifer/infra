/**
 * Creates a Component. The schema, not the handler, refuses a field from another
 * kind, such as `schedule` on a service.
 */
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { apps, components } from '../../db/schema.ts';
import {
  AUTH_NEEDS_A_ROUTE,
  authHasARoute,
} from '../../domain/desired-state.ts';
import { type Command, failed, ok } from '../types.ts';
import { argv } from './command.ts';

/** A DNS label, because the name appears in canonical hostnames. */
const componentName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

/** Checked for shape only: the platform's cron evaluates it, never core. */
export const cronExpression = z
  .string()
  .trim()
  .regex(
    /^(\S+\s+){4}\S+$/,
    'must be a five-field cron expression, e.g. "0 3 * * *"',
  );

const common = {
  appId: z.uuid(),
  name: componentName,
  reach: z.enum(['none', 'private', 'public']).default('private'),
  auth: z.enum(['none', 'proxy']).default('proxy'),
  /** Optional, unlike the edit: a new Component has no entrypoint to half-change. */
  command: argv.nullable().optional(),
  args: argv.nullable().optional(),
};

export const createComponentInput = z
  .discriminatedUnion('kind', [
    z
      .object({
        ...common,
        kind: z.literal('service'),
        /** False for a queue worker. */
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
        /** Absent means unscheduled, which renders as a suspended CronJob. */
        schedule: cronExpression.optional(),
      })
      .strict(),
  ])
  /**
   * A proxy filter needs a route to sit on. `setComponentReach` applies the same
   * {@link authHasARoute} rule.
   */
  .refine(authHasARoute, { error: AUTH_NEEDS_A_ROUTE, path: ['auth'] });

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
      expose: exposeFor(input),
      schedule: input.kind === 'job' ? (input.schedule ?? null) : null,
      command: input.command ?? null,
      args: input.args ?? null,
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
 * A website always exposes. A job is `null`: it does not serve, and `false`
 * would mean it chose not to.
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
