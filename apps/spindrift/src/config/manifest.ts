/**
 * Loading and validating the installation manifest.
 *
 * The manifest is durable in Postgres. A declared document from a mounted file
 * (the chart renders one from values into a ConfigMap) or, for tests and local
 * runs, an inline environment document is reconciled into that row at process
 * start. Without a declaration, a process can still recover from the durable
 * row. Validation failures are fatal and name every offending key at once — a
 * half-configured installation must not reach the point where it can place a
 * workload.
 */

import {
  type InstallationManifest,
  installationManifestSchema,
} from './manifest.schema.ts';

/** Path to a YAML or JSON manifest document. */
export const MANIFEST_PATH_VAR = 'SPINDRIFT_MANIFEST_PATH';
/** An inline YAML or JSON manifest document, used in place of a file. */
export const MANIFEST_INLINE_VAR = 'SPINDRIFT_MANIFEST';
/**
 * Deployment attestation set by the chart only when it renders a default-deny
 * NetworkPolicy admitting the configured trusted Gateway peers.
 */
export const TRUSTED_GATEWAY_BOUNDARY_VAR =
  'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY';

/** Raised when the manifest is absent, unparseable, or invalid. */
export class ManifestError extends Error {
  override readonly name = 'ManifestError';
}

type Env = Record<string, string | undefined>;

/**
 * Parse and validate a manifest document. Accepts YAML, and therefore JSON.
 *
 * @param document the raw manifest text
 * @param source where it came from, for error messages
 */
export function parseManifest(
  document: string,
  source: string,
): InstallationManifest {
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

/** Validate a parsed or stored manifest and report every bad field together. */
export function validateManifest(
  manifest: unknown,
  source: string,
): InstallationManifest {
  const result = installationManifestSchema.safeParse(manifest);
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

/** Default file path where the installer chart mounts the ConfigMap. */
export const DEFAULT_MANIFEST_PATH = '/etc/spindrift/manifest.yaml';

/** High-trust default placeholder manifest used when initializing an unseeded installation. */
export const DEFAULT_PLACEHOLDER_MANIFEST: InstallationManifest = {
  installation: 'primary',
  controlPlane: {
    hostname: 'spindrift.example.internal',
  },
  auth: {
    gateway: null,
  },
  dns: {
    apexZone: 'example.internal',
    vanityZone: 'example.internal',
  },
  cloud: {
    artifactsProject: 'artifacts',
    homeVesselProject: 'vessel',
    federation: {
      audience:
        '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/spindrift/providers/spindrift',
      tokenUrl: 'https://sts.googleapis.com/v1/token',
      tokenPath: '/var/run/secrets/spindrift/gcp-token',
      impersonationUrl:
        'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/spindrift-controller@vessel.iam.gserviceaccount.com:generateAccessToken',
    },
  },
  charts: {
    app: 'packages/charts/spindrift-app',
    installer: 'packages/charts/spindrift',
  },
  supplyChain: {
    registry: 'ghcr.io/spindrift',
    verifier: 'ghcr.io/spindrift/spindrift-verifier',
    signer:
      'gcpkms://projects/artifacts/locations/global/keyRings/keys/cryptoKeys/signer',
  },
  github: {
    clientId: 'Iv1.918d699f36ee7afc',
    oauthBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
    buildWorkflow:
      'spindrift/infra/.github/workflows/spindrift-build.yml@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6',
  },
  build: {
    routes: [{ name: 'hosted', adapter: 'github-actions' }],
    zeroConfigFrontend: 'ghcr.io/railwayapp/railpack:railpack-frontend',
  },
  secretStore: {
    adapter: 'onepassword',
    endpoint:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    container: 'vault',
  },
  targets: [
    {
      name: 'primary',
      adapter: 'kubernetes',
      connection: {
        apiServer: 'https://kubernetes.default.svc',
        namespace: 'spindrift-apps',
        delivery: {
          flavour: 'flux-helmrelease',
          namespace: 'spindrift-apps',
          sourceRef: { name: 'infra', namespace: 'flux-system' },
        },
        chartContract: '2',
      },
    },
    {
      name: 'vesselcloudrun',
      adapter: 'cloudrun',
      connection: {
        project: 'vessel',
        region: 'global',
        endpoint: 'https://run.googleapis.com',
      },
    },
    {
      name: 'vesselstatic',
      adapter: 'static',
      connection: {
        project: 'vessel',
        endpoint: 'https://firebasehosting.googleapis.com',
      },
    },
  ],
};

/**
 * Read the manifest the environment points at.
 *
 * `SPINDRIFT_MANIFEST_PATH` wins over `SPINDRIFT_MANIFEST`. If neither is set,
 * checks `DEFAULT_MANIFEST_PATH` (/etc/spindrift/manifest.yaml) before erroring.
 */
export async function loadManifest(
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  const manifest = await loadManifestIfPresent(env);
  if (manifest !== null) return manifest;

  throw new ManifestError(
    `no installation manifest: set ${MANIFEST_PATH_VAR} to a manifest file or ${MANIFEST_INLINE_VAR} to its contents`,
  );
}

/**
 * Read a declared manifest when one is available.
 *
 * An explicit missing path is still an error: it is a broken declaration, not
 * the same state as no declaration. `null` means callers may deliberately fall
 * back to a durable copy.
 */
export async function loadManifestIfPresent(
  env: Env = Bun.env,
): Promise<InstallationManifest | null> {
  const explicitPath = env[MANIFEST_PATH_VAR]?.trim();
  const path = explicitPath || DEFAULT_MANIFEST_PATH;

  const file = Bun.file(path);
  if (await file.exists()) {
    return parseManifest(await file.text(), path);
  }

  if (explicitPath) {
    throw new ManifestError(
      `${MANIFEST_PATH_VAR}=${explicitPath}: no such file`,
    );
  }

  const inline = env[MANIFEST_INLINE_VAR];
  if (inline?.trim()) {
    return parseManifest(inline, `$${MANIFEST_INLINE_VAR}`);
  }
  return null;
}

/**
 * Refuse to enable header authentication without its non-bypassable boundary.
 *
 * The process cannot observe a Kubernetes NetworkPolicy from inside its own
 * pod. The installer chart therefore sets this attestation beside the policy;
 * a manifest copied into an unrestricted deployment fails closed at boot.
 */
export function assertTrustedGatewayBoundary(
  manifest: InstallationManifest,
  env: Env = Bun.env,
): void {
  if (
    manifest.auth.gateway !== null &&
    env[TRUSTED_GATEWAY_BOUNDARY_VAR] !== 'true'
  ) {
    throw new ManifestError(
      `auth.gateway requires ${TRUSTED_GATEWAY_BOUNDARY_VAR}=true from a deployment that strips identity headers and restricts ingress to the trusted Gateway`,
    );
  }
}

export type {
  GatewayAuthConfig,
  InstallationManifest,
} from './manifest.schema.ts';
