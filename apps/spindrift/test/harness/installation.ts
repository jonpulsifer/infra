/**
 * The installation a test runs as, and the connect inputs, vessels and Target
 * rows that fixtures build on.
 */
import { join } from 'node:path';
import { GCP_CREDENTIALS_VAR } from '@repo/archive/federation-credential';
import type { ConnectTargetInput } from '../../src/commands/targets/connect.ts';
import {
  type AuthoredManifest,
  type TargetAdapter,
  toAuthoredManifest,
} from '../../src/config/manifest.schema.ts';
import {
  HOSTNAME_VAR,
  type InstallationManifest,
  PUBLIC_HOSTNAME_VAR,
  parseManifest,
  RESERVED_HOSTNAMES_VAR,
  resolveManifest,
  VERSION_VAR,
} from '../../src/config/manifest.ts';
import type { Database } from '../../src/db/client.ts';
import {
  type NewTarget,
  type NewVessel,
  type Vessel,
  vessels,
} from '../../src/db/schema.ts';
import {
  type DeployTargetRef,
  deployTargetOf,
  type TargetConnection,
} from '../../src/domain/target.ts';
import type { VesselKind, VesselLocation } from '../../src/domain/vessel.ts';
import { defaultVesselId } from './db.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');

/** The env the chart renders for a deployment, which no manifest carries. */
export const FIXTURE_DEPLOYMENT_ENV: Record<string, string> = {
  [GCP_CREDENTIALS_VAR]: join(
    import.meta.dir,
    '../fixtures/gcp-credentials.json',
  ),
  // The control plane's host, which is also the passkey relying party.
  [HOSTNAME_VAR]: 'spindrift.example.test',
  // The tunnel's name for the machine routes, in the fixture's public zone.
  [PUBLIC_HOSTNAME_VAR]: 'spindrift-control.example.test',
  // Another workload's name on the Apps gateway, in the same zone.
  [RESERVED_HOSTNAMES_VAR]: 'kthx.example.test',
  // Set so a test can tell a forwarded version from a hard-coded null.
  [VERSION_VAR]: 'sha256:deadbeef0123',
};

let cached: InstallationManifest | null = null;

/** The fixture installation, parsed and resolved through the real loader. */
export async function fixtureManifest(): Promise<InstallationManifest> {
  if (cached === null) {
    cached = await resolveManifest(
      parseManifest(await Bun.file(FIXTURE).text(), FIXTURE),
      FIXTURE_DEPLOYMENT_ENV,
    );
  }
  return cached;
}

/** The fixture as an operator authors it; the schema refuses the resolved one. */
export async function authoredFixture(): Promise<AuthoredManifest> {
  return toAuthoredManifest(await fixtureManifest());
}

/** A cluster's connect input. Its delivery and chart values have no defaults. */
export function clusterInput(
  overrides: Partial<KubernetesConnectInput> = {},
): KubernetesConnectInput {
  return {
    kind: 'cluster',
    vessel: 'cluster',
    apiServer: 'https://cluster.example.test',
    namespace: 'apps',
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: 'apps',
      sourceRef: { name: 'charts', namespace: 'delivery' },
    },
    // The edge the ExternalAuth backend below serves. Nothing reports an edge,
    // and `reaches` is unset, so this cluster has no tunnel.
    authReaches: ['private'],
    // Without a gateway, no Component with a reach can land on this cluster.
    chartValues: {
      platform: {
        gateway: { name: 'cluster-gateway', namespace: 'gateway' },
        externalAuth: {
          name: 'oauth2-proxy',
          namespace: 'oauth2-proxy',
          port: 80,
        },
        dns: {
          privateAddress: '10.0.0.1',
          tunnelHostname: 'tunnel.example.test',
        },
      },
    },
    ...overrides,
  };
}

export type KubernetesConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'cluster' }
>;

/** Shared by cloud Target connections and the fakes behind them. */
export const CLOUD_ENDPOINTS = {
  run: 'https://run.example.test',
  hosting: 'https://hosting.example.test',
  policy: 'https://admission.example.test',
  /** Fires scheduled jobs; not part of the Target's control plane. */
  scheduler: 'https://scheduler.example.test',
} as const;

export function cloudInput(
  overrides: Partial<CloudConnectInput> = {},
): CloudConnectInput {
  return {
    kind: 'gcp-project',
    vessel: 'cloud',
    project: 'example-vessel',
    region: 'somewhere',
    runEndpoint: CLOUD_ENDPOINTS.run,
    hostingEndpoint: CLOUD_ENDPOINTS.hosting,
    // Without one, no scheduled job can be placed on this Target.
    serviceAccount: 'runtime@example-vessel.iam.gserviceaccount.com',
    ...overrides,
  };
}

export type CloudConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'gcp-project' }
>;

/** Shared by Vercel Target connections and the fake Vercel API. */
export const VERCEL_ENDPOINT = 'https://vercel.example.test';

export function vercelInput(
  overrides: Partial<VercelConnectInput> = {},
): VercelConnectInput {
  return {
    kind: 'vercel-team',
    vessel: 'edge',
    team: 'example-team',
    endpoint: VERCEL_ENDPOINT,
    ...overrides,
  };
}

export type VercelConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'vercel-team' }
>;

export type CloudflareConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'cloudflare-account' }
>;

/** Shared by Cloudflare Target connections and the fake Cloudflare API. */
export const CLOUDFLARE_ENDPOINT = 'https://cloudflare.example.test';

export function cloudflareInput(
  overrides: Partial<CloudflareConnectInput> = {},
): CloudflareConnectInput {
  return {
    kind: 'cloudflare-account',
    vessel: 'cloudflare',
    account: 'example-account',
    endpoint: CLOUDFLARE_ENDPOINT,
    ...overrides,
  };
}

/** A connection's surface half; {@link vesselFor} is the boundary half. */
export function connectionFor(adapter: TargetAdapter): TargetConnection {
  switch (adapter) {
    case 'kubernetes': {
      const input = clusterInput();
      return {
        adapter,
        namespace: input.namespace,
        delivery: input.delivery,
        // Must match what the connect act stores, field for field.
        ...(input.chartValues === undefined
          ? {}
          : { chartValues: input.chartValues }),
      };
    }
    case 'cloudrun': {
      const input = cloudInput();
      return {
        adapter,
        region: input.region,
        endpoint: input.runEndpoint,
        policyEndpoint: CLOUD_ENDPOINTS.policy,
        ...(input.serviceAccount === undefined
          ? {}
          : { serviceAccount: input.serviceAccount }),
      };
    }
    case 'static': {
      const input = cloudInput();
      return { adapter, endpoint: input.hostingEndpoint };
    }
    case 'vercel':
      return { adapter, endpoint: vercelInput().endpoint };
    case 'cloudflare-pages':
      return { adapter, endpoint: cloudflareInput().endpoint };
  }
}

/**
 * Which seeded vessel a fixture Target of each adapter sits on. A fixture
 * convention only: the domain maps no surface to a kind of vessel.
 */
const FIXTURE_VESSEL_KIND = {
  kubernetes: 'cluster',
  cloudrun: 'gcp-project',
  static: 'gcp-project',
  vercel: 'vercel-team',
  'cloudflare-pages': 'cloudflare-account',
} as const satisfies Record<TargetAdapter, VesselKind>;

export function fixtureVesselKind(adapter: TargetAdapter): VesselKind {
  return FIXTURE_VESSEL_KIND[adapter];
}

export function vesselFor(adapter: TargetAdapter): NewVessel {
  const kind = fixtureVesselKind(adapter);
  return {
    name: `vessel-${crypto.randomUUID()}`,
    kind,
    location: fixtureLocation(kind),
  };
}

function fixtureLocation(kind: VesselKind): VesselLocation {
  switch (kind) {
    case 'cluster':
      return { kind, apiServer: clusterInput().apiServer };
    case 'gcp-project':
      return { kind, project: cloudInput().project };
    case 'vercel-team':
      return { kind, team: vercelInput().team };
    case 'cloudflare-account':
      return { kind, account: cloudflareInput().account };
  }
}

export async function insertVessel(
  db: Database,
  adapter: TargetAdapter = 'kubernetes',
  overrides: Partial<NewVessel> = {},
): Promise<Vessel> {
  const [row] = await db
    .insert(vessels)
    .values({ ...vesselFor(adapter), ...overrides })
    .returning();
  return row!;
}

/** The flat view an adapter receives, composed as core composes it. */
export function deployTargetFor(
  adapter: TargetAdapter,
  vesselName = `vessel-${adapter}`,
): DeployTargetRef {
  const vessel = vesselFor(adapter);
  return deployTargetOf(
    { adapter, connection: connectionFor(adapter) },
    {
      name: vesselName,
      location: vessel.location!,
      servedHosts: vessel.servedHosts ?? null,
      reachableRegistries: vessel.reachableRegistries ?? null,
    },
  );
}

/** A complete, healthy Target row; override only what the test asserts. */
export function targetValues(overrides: Partial<NewTarget> = {}): NewTarget {
  const adapter = overrides.adapter ?? 'kubernetes';
  return {
    adapter,
    rank: 0,
    // The isolated database seeds one vessel per kind.
    vesselId: defaultVesselId(fixtureVesselKind(adapter)),
    connection: connectionFor(adapter),
    health: 'healthy',
    // Matches `clusterInput`: an authenticated private edge and no tunnel.
    ...(adapter === 'kubernetes' ? { authReaches: ['private' as const] } : {}),
    ...overrides,
  };
}
