import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

export const githubActionsConfigSchema = z
  .object({
    name: nonEmptyString,
    adapter: z.literal('github-actions'),
    sealPublicKey: nonEmptyString.optional(),
  })
  .strict();

export const cloudBuildConfigSchema = z
  .object({
    name: nonEmptyString,
    adapter: z.literal('cloud-build'),
    endpoint: z.url(),
    logsEndpoint: z.url(),
    project: nonEmptyString,
    region: nonEmptyString,
    image: nonEmptyString,
  })
  .strict();

export const inClusterConfigSchema = z
  .object({
    name: nonEmptyString,
    adapter: z.literal('in-cluster'),
    endpoint: z.url(),
    namespace: nonEmptyString,
    image: nonEmptyString,
    serviceAccount: nonEmptyString,
  })
  .strict();

/**
 * The bosun build route (Task: bosun build route). `class` names the skiff
 * pool a request is routed to — a bosun installation's own vocabulary, not
 * this contract's, so it is an opaque string rather than an enum.
 *
 * `provenanceBuilderId` is configured rather than a code-defined constant the
 * way the other three routes' builder ids are: theirs name a vendor's own
 * domain (`github.com`, `spindrift.dev`), identical in every installation,
 * while a bosun fleet's builder id names *this* installation's own bosun
 * host — exactly the kind of value §20 puts in the manifest rather than in
 * source.
 */
export const bosunConfigSchema = z
  .object({
    name: nonEmptyString,
    adapter: z.literal('bosun'),
    class: nonEmptyString,
    provenanceBuilderId: nonEmptyString,
  })
  .strict();

export const buildRouteAdapterSchema = z.enum([
  'github-actions',
  'cloud-build',
  'in-cluster',
  'bosun',
]);

export const buildRouteSchema = z.discriminatedUnion('adapter', [
  githubActionsConfigSchema,
  cloudBuildConfigSchema,
  inClusterConfigSchema,
  bosunConfigSchema,
]);
