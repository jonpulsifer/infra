/**
 * Parsing, validating and resolving the installation manifest. Validation
 * reports every offending key at once.
 */

import { loadDeploymentFederation } from '@repo/archive/federation-credential';
import {
  type AuthoredManifest,
  type InstallationManifest,
  installationManifestSchema,
} from './manifest.schema.ts';
import { upgradeManifestDocument } from './manifest-upgrade.ts';

/**
 * Set by the chart only when it renders a default-deny NetworkPolicy admitting
 * the configured trusted Gateway peers.
 */
export const TRUSTED_GATEWAY_BOUNDARY_VAR =
  'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY';

/** Set by the chart from the `hostname` that renders the Gateway. */
export const HOSTNAME_VAR = 'SPINDRIFT_HOSTNAME';

/** The public name a tunnel forwards the machine routes on. */
export const PUBLIC_HOSTNAME_VAR = 'SPINDRIFT_PUBLIC_HOSTNAME';

/** Comma-separated names served on the Apps gateway that no App may take. */
export const RESERVED_HOSTNAMES_VAR = 'SPINDRIFT_RESERVED_HOSTNAMES';

/** Also telemetry's `service.version`. Unset resolves to `null` here. */
export const VERSION_VAR = 'SPINDRIFT_VERSION';

/**
 * The relying party of an in-cluster-only deployment, which serves no origin.
 * A browser refuses a passkey ceremony against it, so nobody can enrol.
 */
export const UNSERVED_HOSTNAME = 'spindrift.example.com';

export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

type Env = Record<string, string | undefined>;

/** Accepts YAML, and therefore JSON. `source` names the document in errors. */
export function parseManifest(
  document: string,
  source: string,
): AuthoredManifest {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(document);
  } catch (cause) {
    throw new ManifestError(
      `${source}: not valid YAML: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return validateManifest(parsed, source);
}

/**
 * Upgrades before validating, so a stored row or a restored export written
 * under an older schema still parses.
 */
export function validateManifest(
  manifest: unknown,
  source: string,
): AuthoredManifest {
  const result = installationManifestSchema.safeParse(
    upgradeManifestDocument(manifest),
  );
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return `  ${path === '' ? '(root)' : path}: ${issue.message}`;
      })
      .join('\n');
    throw new ManifestError(
      `${source}: invalid installation manifest\n${issues}`,
    );
  }
  return result.data;
}

/** Seeded into an installation that has no stored manifest yet. */
export const DEFAULT_PLACEHOLDER_MANIFEST: AuthoredManifest = {
  installation: {
    name: 'default',
    controlPlaneVessel: 'primary',
    homeVessel: 'spindrift',
  },
  auth: {
    gateway: null,
  },
  dns: {
    zones: [{ name: 'example.com', reaches: ['private', 'public'] }],
  },
  sources: {
    buckets: ['bluenose-spindrift-source'],
  },
  charts: {
    app: 'packages/charts/spindrift-app',
  },
  supplyChain: {
    registry: ['ghcr.io/spindrift'],
    verifier: 'ghcr.io/spindrift/spindrift-verifier',
    signer:
      'gcpkms://projects/spindrift-artifacts/locations/us-central1/keyRings/keys/cryptoKeys/signer',
  },
  github: {
    webBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
    // Never a placeholder: `connectRepository` writes this into connected
    // repositories. Null makes connect refuse until an operator states one.
    buildWorkflow: null,
  },
  build: {
    routes: [{ name: 'github', adapter: 'github-actions' }],
    // A real image: a build pulls it whenever a scope has no Dockerfile. Pinned
    // so rebuilding a bundle digest cannot silently change what built it.
    // GHCR refuses to serve railwayapp/railpack; the frontend is its own
    // repository.
    zeroConfigFrontend: 'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
  },
  secretStore: {
    adapter: 'onepassword',
    endpoint:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
  },
  vessels: [
    {
      name: 'primary',
      kind: 'cluster',
      location: { apiServer: 'https://kubernetes.default.svc' },
    },
    {
      name: 'spindrift',
      kind: 'gcp-project',
      location: { project: 'spindrift-vessel' },
      shared: {
        sourceBucket: 'bluenose-spindrift-source',
        artifactsProject: 'spindrift-artifacts',
        secretStoreContainer: 'spindrift-vault',
      },
    },
  ],
  targets: [
    {
      vessel: 'primary',
      adapter: 'kubernetes',
      connection: {
        namespace: 'spindrift-apps',
        appNamespace: 'app-{app}',
        datastoreNamespace: 'spindrift-datastores',
        delivery: {
          flavour: 'flux-helmrelease',
          namespace: 'spindrift-apps',
          sourceRef: { name: 'infra', namespace: 'flux-system' },
        },
      },
    },
    {
      vessel: 'spindrift',
      adapter: 'cloudrun',
      connection: {
        region: 'spindrift-region',
        endpoint: 'https://run.googleapis.com',
      },
    },
    {
      vessel: 'spindrift',
      adapter: 'static',
      connection: {
        endpoint: 'https://firebasehosting.googleapis.com',
      },
    },
  ],
};

/**
 * True while the name, the store adapter and the registry all still equal the
 * placeholder's. All three, not any: `onepassword` is also a real choice.
 */
export function isUnconfiguredInstallation(
  manifest: AuthoredManifest,
): boolean {
  const stand = DEFAULT_PLACEHOLDER_MANIFEST;
  return (
    manifest.installation.name === stand.installation.name &&
    manifest.secretStore.adapter === stand.secretStore.adapter &&
    Bun.deepEquals(manifest.supplyChain.registry, stand.supplyChain.registry)
  );
}

/**
 * Joins the deployment's facts onto an authored document. Runs on every read:
 * the credential is a projected volume the kubelet can re-render.
 */
export async function resolveManifest(
  manifest: AuthoredManifest,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  return {
    ...manifest,
    cloud: { federation: await loadDeploymentFederation(env) },
    boundary: { trustedGateway: env[TRUSTED_GATEWAY_BOUNDARY_VAR] === 'true' },
    controlPlane: {
      hostname: env[HOSTNAME_VAR]?.trim() || UNSERVED_HOSTNAME,
      publicHostname: env[PUBLIC_HOSTNAME_VAR]?.trim().toLowerCase() || null,
      reservedHostnames: (env[RESERVED_HOSTNAMES_VAR] ?? '')
        .split(',')
        .flatMap((host) => host.trim().toLowerCase() || []),
      version: env[VERSION_VAR]?.trim() || null,
    },
  };
}

/**
 * Refuses `auth.gateway` unless the deployment attests the NetworkPolicy, which
 * the pod cannot observe. A sentence, so `configureInstallation` can show it.
 */
export function trustedGatewayRefusal(
  manifest: Pick<InstallationManifest, 'auth' | 'boundary'>,
): string | null {
  if (manifest.auth.gateway === null || manifest.boundary.trustedGateway) {
    return null;
  }
  return `auth.gateway requires ${TRUSTED_GATEWAY_BOUNDARY_VAR}=true from a deployment that strips identity headers and restricts ingress to the trusted Gateway`;
}

export function assertTrustedGatewayBoundary(
  manifest: Pick<InstallationManifest, 'auth' | 'boundary'>,
): void {
  const refusal = trustedGatewayRefusal(manifest);
  if (refusal !== null) throw new ManifestError(refusal);
}

export type {
  AuthoredManifest,
  GatewayAuthConfig,
  InstallationManifest,
} from './manifest.schema.ts';
