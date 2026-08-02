/**
 * The installation a test runs as.
 *
 * §20's extraction contract puts every installation-naming value in the
 * manifest, and `CommandContext` carries one so no command has to read a
 * module-level singleton. That makes "which installation" a per-test choice, and
 * this is where tests make it: the fixture manifest, parsed through the real
 * loader so a schema change that the fixture does not satisfy fails here rather
 * than only in production.
 *
 * `targetValues` exists for the same reason in the other direction. A Target row
 * has required columns a test does not care about — a connection, a health — and
 * restating them at every insert would mean a test asserting something about
 * ranks silently deciding what a healthy Target looks like.
 */
import { join } from 'node:path';
import { VALUES_CONTRACT } from '../../src/adapters/deploy/kubernetes/values.ts';
import type { ConnectTargetInput } from '../../src/commands/targets/connect.ts';
import { GCP_CREDENTIALS_VAR } from '../../src/config/federation-credential.ts';
import {
  type AuthoredManifest,
  type TargetAdapter,
  toAuthoredManifest,
} from '../../src/config/manifest.schema.ts';
import {
  type InstallationManifest,
  parseManifest,
  resolveManifest,
} from '../../src/config/manifest.ts';
import type { NewTarget } from '../../src/db/schema.ts';
import type { TargetConnection } from '../../src/domain/target.ts';

const FIXTURE = join(import.meta.dir, '../fixtures/installation.example.yaml');

/**
 * The fixture deployment's own credential.
 *
 * §13's federation is not in the manifest — it is read from the
 * `external_account` document the installer chart renders — so a test
 * installation needs a deployment as well as a document. This is that
 * deployment, and pointing the real resolver at it is what makes every test
 * context carry federation the same way a pod does.
 */
export const FIXTURE_DEPLOYMENT_ENV: Record<string, string> = {
  [GCP_CREDENTIALS_VAR]: join(
    import.meta.dir,
    '../fixtures/gcp-credentials.json',
  ),
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

/**
 * The same installation as an operator authors it.
 *
 * {@link fixtureManifest} is resolved — the deployment's federation is joined
 * onto it — and the schema refuses that document on the way in. A test writing
 * a manifest wants this one; a test carrying a context wants the resolved one.
 */
export async function authoredFixture(): Promise<AuthoredManifest> {
  return toAuthoredManifest(await fixtureManifest());
}

/**
 * The connect input a cluster takes, with anything a test cares about
 * overridden.
 *
 * A Kubernetes Target carries more than an endpoint — §6 makes the delivery
 * flavour a Target's own declaration, and the App chart's source is a
 * prerequisite until the OCI swap — and none of it has a default (§20). So the
 * shape lives here once rather than in every test that connects a cluster and
 * does not care which operator it runs.
 */
export function clusterInput(
  overrides: Partial<KubernetesConnectInput> = {},
): KubernetesConnectInput {
  return {
    kind: 'kubernetes',
    name: 'cluster',
    apiServer: 'https://cluster.example.test',
    namespace: 'apps',
    delivery: {
      flavour: 'flux-helmrelease',
      namespace: 'apps',
      sourceRef: { name: 'charts', namespace: 'delivery' },
    },
    chartContract: VALUES_CONTRACT,
    // The edge the ExternalAuth backend below is. Asserted because §3 says
    // nothing reports it — and `reaches` is left unasserted for the same reason,
    // so this fixture cluster has an authenticated edge and no tunnel.
    authReaches: ['private'],
    // A connected cluster names the gateway its routes attach to. Absent, every
    // Component with a reach is a non-candidate — which is the point of the
    // check, and would make every fixture here a Target nothing can land on.
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

/** The kubernetes arm of `connectTargetInput`. */
export type KubernetesConnectInput = Extract<
  ConnectTargetInput,
  { kind: 'kubernetes' }
>;

/**
 * The control APIs a connected cloud project is driven through.
 *
 * Constants rather than per-test strings because both a Target's connection and
 * the fake standing behind it have to agree on them: a fake serving one host
 * while the adapter addresses another is a test that fails for a reason nobody
 * would look for. The fakes default to these.
 */
export const CLOUD_ENDPOINTS = {
  run: 'https://run.example.test',
  hosting: 'https://hosting.example.test',
  policy: 'https://admission.example.test',
} as const;

/** The connect input a cloud project takes, with anything overridden. */
export function cloudInput(
  overrides: Partial<CloudConnectInput> = {},
): CloudConnectInput {
  return {
    kind: 'cloud',
    name: 'cloud',
    project: 'example-vessel',
    region: 'somewhere',
    runEndpoint: CLOUD_ENDPOINTS.run,
    hostingEndpoint: CLOUD_ENDPOINTS.hosting,
    ...overrides,
  };
}

/** The cloud arm of `connectTargetInput`. */
export type CloudConnectInput = Extract<ConnectTargetInput, { kind: 'cloud' }>;

/** A connection of the shape one adapter type needs. */
export function connectionFor(adapter: TargetAdapter): TargetConnection {
  switch (adapter) {
    case 'kubernetes': {
      const input = clusterInput();
      return {
        adapter,
        apiServer: input.apiServer,
        namespace: input.namespace,
        delivery: input.delivery,
        // Mirrors what the connect act stores, field for field: a helper that
        // drops one of them makes every "the row holds what was connected"
        // assertion pass for the wrong reason.
        ...(input.chartContract === undefined
          ? {}
          : { chartContract: input.chartContract }),
        ...(input.chartValues === undefined
          ? {}
          : { chartValues: input.chartValues }),
      };
    }
    case 'cloudrun': {
      const input = cloudInput();
      return {
        adapter,
        project: input.project,
        region: input.region,
        endpoint: input.runEndpoint,
        policyEndpoint: CLOUD_ENDPOINTS.policy,
      };
    }
    case 'static': {
      const input = cloudInput();
      return {
        adapter,
        project: input.project,
        endpoint: input.hostingEndpoint,
      };
    }
  }
}

/** A complete, healthy Target row, with anything a test cares about overridden. */
export function targetValues(overrides: Partial<NewTarget> = {}): NewTarget {
  const adapter = overrides.adapter ?? 'kubernetes';
  return {
    name: `target-${crypto.randomUUID()}`,
    adapter,
    rank: 0,
    connection: connectionFor(adapter),
    health: 'healthy',
    // The cluster fixture wires an ExternalAuth backend, so it asserts the edge
    // that backend is. `private` only, and no `reaches` at all: a tunnel is the
    // thing §3 says nothing reports, so an unasserted Target does not have one.
    ...(adapter === 'kubernetes' ? { authReaches: ['private' as const] } : {}),
    ...overrides,
  };
}
