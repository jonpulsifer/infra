/**
 * The installation manifest: every value that names this installation. Those
 * have no defaults; a vendor API `endpoint` defaults in its adapter. Values the
 * installer chart renders come from the deployment instead.
 */

import type { FederationConfig } from '@repo/archive/federation';
import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);

/**
 * Must contain `{app}`, or every App's release goes to one namespace. The
 * expanded name is checked where it is built.
 */
const appNamespaceSchema = nonEmptyString.refine(
  (pattern) => pattern.includes('{app}'),
  { message: 'must contain {app}, or every App shares one namespace' },
);

/** A DNS label naming a vessel, shared with the connect act. */
export const targetNameSchema = nonEmptyString
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

const zone = nonEmptyString.regex(
  /^(localhost|(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+)$/,
  'must be a lowercase DNS name or localhost',
);

const headerName = nonEmptyString.regex(
  /^[A-Za-z0-9-]+$/,
  'must be an HTTP header name',
);

/**
 * The Gateway presents a normalized subject over a non-bypassable hop.
 * `adapterKey` tells apart two Gateways with the same issuer and subject.
 */
export const gatewayAuthSchema = z
  .object({
    adapterKey: nonEmptyString,
    issuer: z.string().url(),
    subjectHeader: headerName,
  })
  .strict();

export const targetAdapterSchema = z.enum([
  'kubernetes',
  'cloudrun',
  'static',
  'vercel',
  'cloudflare-pages',
]);

export const storeAdapterSchema = z.enum([
  'onepassword',
  'gcp-secret-manager',
  'vercel',
]);

import {
  buildRouteAdapterSchema,
  buildRouteSchema,
} from './build-route-schemas.ts';

export { buildRouteAdapterSchema, buildRouteSchema };

const kubernetesDeliverySchema = z.discriminatedUnion('flavour', [
  z
    .object({
      flavour: z.literal('flux-helmrelease'),
      namespace: nonEmptyString,
      sourceRef: z
        .object({
          name: nonEmptyString,
          namespace: nonEmptyString,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      flavour: z.literal('argo-application'),
      namespace: nonEmptyString,
      project: nonEmptyString,
      repoUrl: nonEmptyString,
      revision: nonEmptyString,
      server: nonEmptyString,
    })
    .strict(),
]);

const reachSchema = z.enum(['none', 'private', 'public']);

/** Required on the home vessel and refused on every other. */
export const sharedServicesSchema = z
  .object({
    /** Where archive sources and artifacts are staged before a build. */
    sourceBucket: nonEmptyString,
    /**
     * Holds build artifacts and signing material for every vessel. It may be a
     * project the installation runs nothing in.
     */
    artifactsProject: nonEmptyString,
    /** The vessel's project for Secret Manager, the vault for 1Password. */
    secretStoreContainer: nonEmptyString,
  })
  .strict();

const repositoryPath = nonEmptyString.refine(
  (value) => !value.startsWith('/') && !value.split(/[\\/]/).includes('..'),
  'must stay inside the repository',
);

/** Absent means unstated; `[]` means stated and empty. */
const vesselFacts = {
  name: targetNameSchema,
  servedHosts: z.array(nonEmptyString).optional(),
  reachableRegistries: z.array(nonEmptyString).optional(),
  shared: sharedServicesSchema.optional(),
  /**
   * This boundary's directory in the infrastructure repository, where a
   * generated remediation goes. Absent for a boundary connected in the UI.
   */
  terraformRoot: repositoryPath.optional(),
};

/**
 * `location` is optional so a seed can leave the address to the connect act. A
 * Target is addressable once its connection and its vessel's location exist.
 */
export const vesselSeedSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...vesselFacts,
      kind: z.literal('cluster'),
      location: z
        .object({
          apiServer: z.url(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('gcp-project'),
      location: z
        .object({
          project: nonEmptyString,
          /**
           * The network a Datastore on this vessel is reached over. Absent for
           * a project serving only Cloud Run and Firebase Hosting.
           */
          network: z
            .object({
              name: nonEmptyString,
              region: nonEmptyString,
            })
            .strict()
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('vercel-team'),
      location: z
        .object({
          /** A slug or a `team_…` id: the API takes either as `teamId`. */
          team: nonEmptyString,
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      ...vesselFacts,
      kind: z.literal('cloudflare-account'),
      location: z
        .object({
          account: nonEmptyString,
          endpoint: z.url().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

/**
 * `connection` is optional so an operator can seed a Target and connect it in
 * the product. It holds no credentials; boundary facts live on the vessel.
 */
export const targetSeedSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('kubernetes'),
      /** Absent means unasserted, which differs from `[]`. */
      reaches: z.array(reachSchema).optional(),
      authReaches: z.array(reachSchema).optional(),
      connection: z
        .object({
          /**
           * Every App namespace copies its Pod Security labels, and the connect
           * probe checks them here.
           */
          namespace: nonEmptyString,
          /** `{app}` is the only placeholder. */
          appNamespace: appNamespaceSchema.optional(),
          /** A Datastore outlives its Apps, so this is never an App's. */
          datastoreNamespace: nonEmptyString.optional(),
          delivery: kubernetesDeliverySchema,
          logHistorySeconds: z.number().int().nonnegative().optional(),
          /** Untyped: which keys the chart allows is the adapter's call. */
          chartValues: z.record(z.string(), z.unknown()).optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('cloudrun'),
      connection: z
        .object({
          region: nonEmptyString,
          endpoint: z.url().optional(),
          policyEndpoint: z.url().optional(),
          /** The identity a revision runs as. */
          serviceAccount: nonEmptyString.optional(),
          logHistorySeconds: z.number().int().nonnegative().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('static'),
      connection: z
        .object({
          endpoint: z.url().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('vercel'),
      connection: z
        .object({
          endpoint: z.url().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      vessel: targetNameSchema,
      adapter: z.literal('cloudflare-pages'),
      connection: z
        .object({
          endpoint: z.url().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);

export const installationManifestSchema = z
  .object({
    /**
     * The two vessel pointers are not foreign keys, so `disconnectTarget`
     * guards the vessels they name.
     */
    installation: z
      .object({
        /** Shown in the UI and logs. */
        name: nonEmptyString,
        controlPlaneVessel: targetNameSchema,
        /** The vessel holding the shared services. */
        homeVessel: targetNameSchema,
      })
      .strict(),

    auth: z
      .object({
        /**
         * Null means passkeys only. A Gateway's assertions authenticate only
         * after an operator links one from a fresh passkey session.
         */
        gateway: gatewayAuthSchema.nullable(),
      })
      .strict(),

    dns: z
      .object({
        /**
         * An App that pins no zone mints in the first one serving its reach.
         * Zones must hold only generated names; nothing checks that.
         */
        zones: z
          .array(
            z
              .object({
                name: zone,
                /** No `none`: nothing routes to such a Component. */
                reaches: z.array(z.enum(['private', 'public'])).min(1),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),

    sources: z
      .object({
        /** First-party GCS buckets; staging uses `shared.sourceBucket`. */
        buckets: z.array(nonEmptyString).min(1),
      })
      .strict(),

    charts: z
      .object({
        /** The chart every deployed Component renders through. */
        app: nonEmptyString,
      })
      .strict(),

    supplyChain: z
      .object({
        /**
         * Every artifact is pushed to each. A Target pulls from one it can
         * reach, or from the first when it names none.
         */
        registry: z
          .union([nonEmptyString, z.array(nonEmptyString).min(1)])
          .transform((value) => (typeof value === 'string' ? [value] : value)),
        /** Where signature verification fetches its material. */
        verifier: nonEmptyString,
        /** A KMS key URI for cosign: a reference, never key material. */
        signer: nonEmptyString,
        /**
         * `projects/<project>/attestors/<name>`. Where a cloud Target's Binary
         * Authorization enforces, an unattested artifact is refused.
         */
        attestor: nonEmptyString.optional(),
      })
      .strict(),

    github: z
      .object({
        /**
         * The web origin for the App manifest flow, install links and clone
         * URLs. GitHub Enterprise's differs from its `apiBaseUrl`.
         */
        webBaseUrl: z
          .url()
          .refine((value) => !value.endsWith('/'), 'must not end with a slash'),
        /**
         * Accounts whose installations are this installation's; a public App
         * can be installed by strangers. Absent means no filter.
         */
        accounts: z.array(nonEmptyString).min(1).optional(),
        /**
         * For an adopted App, whose identity comes from the installation Secret
         * without a slug. A manifest-flow App stores its own.
         */
        appSlug: nonEmptyString.optional(),
        /**
         * A name GitHub can reach, unlike the control-plane hostname. Absent,
         * the created App declares no webhook.
         */
        webhookUrl: z.url().optional(),
        apiBaseUrl: z
          .url()
          .refine((value) => !value.endsWith('/'), 'must not end with a slash'),
        /**
         * The reusable workflow every connected repository's caller runs with
         * that repository's permissions, so whoever can move `<ref>` runs steps
         * in all of them. Null means repositories cannot be connected.
         */
        buildWorkflow: nonEmptyString
          .regex(
            /^[^/@\s]+\/[^/@\s]+\/\.github\/workflows\/[^@\s]+@\S+$/,
            'must be owner/repo/.github/workflows/<file>@<ref>',
          )
          .nullable(),
        /**
         * Where a generated remediation is opened as a pull request. Absent
         * means a remediation can be copied but not opened.
         */
        infrastructureRepository: nonEmptyString
          .regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, 'must be owner/name')
          .optional(),
      })
      .strict(),

    build: z
      .object({
        /**
         * Array order is admin rank. May be empty: a supplied artifact consults
         * no route.
         */
        routes: z
          .array(buildRouteSchema)
          .refine(
            (routes) =>
              new Set(routes.map((r) => r.name)).size === routes.length,
            'build route names must be unique',
          ),
        /**
         * The BuildKit frontend for a scope with no Dockerfile. Every build
         * pulls and trusts it, so the operator pins it.
         */
        zeroConfigFrontend: nonEmptyString,
      })
      .strict(),

    secretStore: z
      .object({
        /**
         * The store of record Kubernetes and cloud Targets write through.
         * Vercel's environment belongs to the Vercel Target, so it is excluded.
         */
        adapter: storeAdapterSchema.exclude(['vercel']),
        /**
         * The endpoint this process writes through. Secret Manager defaults in
         * `createSecretStore`; a self-hosted 1Password Connect server has none.
         */
        endpoint: z.string().url().optional(),
      })
      .strict()
      // Refused here, before the write: the next command's registry rebuild
      // would otherwise throw.
      .refine(
        (store) =>
          store.adapter !== 'onepassword' || store.endpoint !== undefined,
        {
          error:
            'the onepassword adapter needs an endpoint: a Connect server is self-hosted, so there is no universal address to assume',
          path: ['endpoint'],
        },
      ),

    /**
     * Tenancy boundaries: where each is and what it can reach. Its surfaces are
     * the `targets[]` entries that name it.
     */
    vessels: z
      .array(vesselSeedSchema)
      .min(1)
      .refine(
        (vessels) =>
          new Set(vessels.map((v) => v.name)).size === vessels.length,
        'vessel names must be unique',
      ),

    /** Array order is rank, one global placement order. */
    targets: z
      .array(targetSeedSchema)
      .min(1)
      .refine(
        (targets) =>
          new Set(targets.map((t) => `${t.vessel}/${t.adapter}`)).size ===
          targets.length,
        'a vessel carries one surface of each kind',
      ),
  })
  .strict()
  /**
   * Every vessel reference resolves, and only the home vessel has shared
   * services. A vessel's kind does not limit its adapters: connect probes that.
   */
  .superRefine((manifest, context) => {
    const declared = new Set(manifest.vessels.map((vessel) => vessel.name));
    manifest.targets.forEach((target, index) => {
      if (declared.has(target.vessel)) return;
      context.addIssue({
        code: 'custom',
        path: ['targets', index, 'vessel'],
        message: `no vessel named ${target.vessel} is declared`,
      });
    });

    for (const key of ['controlPlaneVessel', 'homeVessel'] as const) {
      if (declared.has(manifest.installation[key])) continue;
      context.addIssue({
        code: 'custom',
        path: ['installation', key],
        message: `no vessel named ${manifest.installation[key]} is declared`,
      });
    }

    manifest.vessels.forEach((vessel, index) => {
      const isHome = vessel.name === manifest.installation.homeVessel;
      if (isHome && vessel.shared === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['vessels', index, 'shared'],
          message: `${vessel.name} is this installation's home vessel and must declare its shared services`,
        });
      }
      if (!isHome && vessel.shared !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['vessels', index, 'shared'],
          message: `only ${manifest.installation.homeVessel}, this installation's home vessel, may declare shared services`,
        });
      }
    });
  });

export type TargetAdapter = z.infer<typeof targetAdapterSchema>;
export type StoreAdapter = z.infer<typeof storeAdapterSchema>;
export type BuildRouteAdapter = z.infer<typeof buildRouteAdapterSchema>;
export type BuildRouteConfig = z.infer<typeof buildRouteSchema>;
export type TargetSeed = z.infer<typeof targetSeedSchema>;
export type VesselSeed = z.infer<typeof vesselSeedSchema>;
export type SharedServices = z.infer<typeof sharedServicesSchema>;
export type GatewayAuthConfig = z.infer<typeof gatewayAuthSchema>;

/** The manifest as authored, stored and edited, with no derived key. */
export type AuthoredManifest = z.infer<typeof installationManifestSchema>;

/** The authored document plus the deployment facts, as every reader gets it. */
export type InstallationManifest = AuthoredManifest & {
  readonly cloud: {
    /** Resolved from the credential the deployment mounts, never authored. */
    readonly federation: FederationConfig | null;
  };
  readonly boundary: {
    /**
     * The chart attests the NetworkPolicy restricting ingress to the trusted
     * Gateway, which the pod cannot observe. False refuses `auth.gateway`.
     */
    readonly trustedGateway: boolean;
  };
  readonly controlPlane: {
    /**
     * The passkey relying party id. The web process binds it once at boot: a
     * ceremony is scoped to the origin it began at.
     */
    readonly hostname: string;
    /**
     * The second name the machine routes answer on. Lowercased, because it is
     * compared against `Host` and against minted names.
     */
    readonly publicHostname: string | null;
    /** Names another workload serves on the Apps gateway. Lowercased. */
    readonly reservedHostnames: readonly string[];
    /** Shown in the shell footer; `null` when the deployment states none. */
    readonly version: string | null;
  };
};

type PointedAt = Pick<AuthoredManifest, 'installation' | 'vessels'>;

/** Throws only for a document the schema would refuse. */
function pointedVessel(manifest: PointedAt, name: string): VesselSeed {
  const vessel = manifest.vessels.find((declared) => declared.name === name);
  if (vessel === undefined) {
    throw new Error(`no vessel named ${name} is declared`);
  }
  return vessel;
}

export function homeVesselOf(manifest: PointedAt): VesselSeed {
  return pointedVessel(manifest, manifest.installation.homeVessel);
}

export function controlPlaneVesselOf(manifest: PointedAt): VesselSeed {
  return pointedVessel(manifest, manifest.installation.controlPlaneVessel);
}

/** Throws only for a document the schema would refuse. */
export function sharedServicesOf(manifest: PointedAt): SharedServices {
  const home = homeVesselOf(manifest);
  if (home.shared === undefined) {
    throw new Error(`${home.name} declares no shared services`);
  }
  return home.shared;
}

/** `null` when the home vessel states no project location. */
export function homeVesselProjectOf(manifest: PointedAt): string | null {
  const location = homeVesselOf(manifest).location;
  return location !== undefined && 'project' in location
    ? location.project
    : null;
}

/** Neither installation pointer is a foreign key; this guard stands in. */
export function isDeclaredInstallationVessel(
  manifest: Pick<AuthoredManifest, 'installation'>,
  vessel: string,
): boolean {
  return (
    vessel === manifest.installation.homeVessel ||
    vessel === manifest.installation.controlPlaneVessel
  );
}

/** Read from the document: a boundary connected in the UI has no root. */
export function terraformRootOf(
  manifest: Pick<AuthoredManifest, 'vessels'>,
  vessel: string,
): string | null {
  const declared = manifest.vessels.find((seed) => seed.name === vessel);
  return declared?.terraformRoot ?? null;
}

/**
 * Strips the derived keys so an edit form can save what it read: the strict
 * schema refuses them.
 */
export function toAuthoredManifest(
  manifest: InstallationManifest,
): AuthoredManifest {
  const {
    cloud: _cloud,
    boundary: _boundary,
    controlPlane: _controlPlane,
    ...authored
  } = manifest;
  return authored;
}
