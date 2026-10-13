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

/** A toleration in the Kubernetes shape, of a taint on a node kept for builds. */
const tolerationSchema = z
  .object({
    key: nonEmptyString.optional(),
    operator: z.enum(['Equal', 'Exists']).optional(),
    value: z.string().optional(),
    effect: z.enum(['NoSchedule', 'PreferNoSchedule', 'NoExecute']).optional(),
  })
  .strict();

export type Toleration = z.infer<typeof tolerationSchema>;

export const inClusterConfigSchema = z
  .object({
    name: nonEmptyString,
    adapter: z.literal('in-cluster'),
    endpoint: z.url(),
    namespace: nonEmptyString,
    image: nonEmptyString,
    serviceAccount: nonEmptyString,
    /** Labels the build node must carry; absent lets the scheduler choose. */
    nodeSelector: z.record(nonEmptyString, z.string()).optional(),
    /** Taints the Job tolerates; absent keeps it off every tainted node. */
    tolerations: z.array(tolerationSchema).optional(),
  })
  .strict();

/**
 * `class` is a bosun skiff pool name, opaque here. `provenanceBuilderId` names
 * this installation's bosun host; the other routes use constants.
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
