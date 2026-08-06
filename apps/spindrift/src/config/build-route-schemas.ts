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

export const buildRouteAdapterSchema = z.enum([
  'github-actions',
  'cloud-build',
  'in-cluster',
]);

export const buildRouteSchema = z.discriminatedUnion('adapter', [
  githubActionsConfigSchema,
  cloudBuildConfigSchema,
  inClusterConfigSchema,
]);
