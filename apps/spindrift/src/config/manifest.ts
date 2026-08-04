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

import { loadDeploymentFederation } from './federation-credential.ts';
import {
  type AuthoredManifest,
  type InstallationManifest,
  installationManifestSchema,
} from './manifest.schema.ts';
import { upgradeManifestDocument } from './manifest-upgrade.ts';

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
 * Validate a parsed or stored manifest and report every bad field together.
 *
 * **Upgrade first, then validate — and that order is the whole of it.** The
 * stored row governs, and `loadStoredManifest` treats a row it cannot parse as
 * a row with no seed in it, re-seeding from the mounted declaration and
 * discarding whatever an operator configured through the UI. Validating a
 * document written under the previous schema before bringing it forward is
 * therefore not a stricter read: it is that discard, fired on a document that
 * was merely old rather than wrong.
 *
 * Here rather than at either call site because both need it and neither should
 * have to remember: the row and the mounted declaration are written by
 * different acts at different times, and a rollout routinely has one of them
 * older than the running build. See `manifest-upgrade.ts`.
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

/** Default file path where the installer chart mounts the ConfigMap. */
export const DEFAULT_MANIFEST_PATH = '/etc/spindrift/manifest.yaml';

/** High-trust default placeholder manifest used when initializing an unseeded installation. */
export const DEFAULT_PLACEHOLDER_MANIFEST: AuthoredManifest = {
  installation: 'default',
  controlPlane: {
    hostname: 'spindrift.example.com',
  },
  auth: {
    gateway: null,
  },
  dns: {
    zones: {
      private: 'example.com',
      public: 'example.com',
    },
  },
  sources: {
    buckets: ['bluenose-spindrift-source'],
    defaultBucket: 'bluenose-spindrift-source',
  },
  cloud: {
    artifactsProject: 'spindrift-artifacts',
    homeVesselProject: 'spindrift-vessel',
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
    clientId: 'Iv1.918d699f36ee7afc',
    oauthBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
    buildWorkflow:
      'spindrift/infra/.github/workflows/spindrift-build.yml@0a7d0ea0ca5c9963eea1104c5802a8af2901d4b6',
  },
  build: {
    routes: [{ name: 'hosted', adapter: 'github-actions' }],
    /**
     * The one value in this manifest that is not a placeholder, because it
     * names a third party's image rather than anything about an installation:
     * §5's ladder pulls it whenever a scope has no Dockerfile, so a
     * stand-in here is a build that cannot fall through.
     *
     * Railpack publishes the frontend as its own repository,
     * `railwayapp/railpack-frontend` — `railwayapp/railpack` is one GHCR
     * refuses to serve at all. The frontend repository does carry a `latest`,
     * and the pin names a version anyway: rebuilding one bundle digest should
     * not silently change what built it, and this is the only input to a
     * zero-config build that no digest covers.
     */
    zeroConfigFrontend: 'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
  },
  secretStore: {
    adapter: 'onepassword',
    endpoint:
      'http://onepassword-connect.external-secrets.svc.cluster.local:8080',
    container: 'spindrift-vault',
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
    },
  ],
  targets: [
    {
      name: 'primary',
      vessel: 'primary',
      adapter: 'kubernetes',
      connection: {
        namespace: 'spindrift-apps',
        delivery: {
          flavour: 'flux-helmrelease',
          namespace: 'spindrift-apps',
          sourceRef: { name: 'infra', namespace: 'flux-system' },
        },
      },
    },
    {
      name: 'spindrift-cloudrun',
      vessel: 'spindrift',
      adapter: 'cloudrun',
      connection: {
        region: 'spindrift-region',
        endpoint: 'https://run.googleapis.com',
      },
    },
    {
      name: 'spindrift-static',
      vessel: 'spindrift',
      adapter: 'static',
      connection: {
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
): Promise<AuthoredManifest> {
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
): Promise<AuthoredManifest | null> {
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
 * Attach the deployment facts an authored document deliberately omits.
 *
 * The one place the two halves meet, and the only place they may: everything
 * upstream of this — parsing, validation, the durable write — handles an
 * {@link AuthoredManifest} with no derived key on it, and everything downstream
 * reads an {@link InstallationManifest} it cannot write back. That is what
 * makes a second copy unrepresentable rather than merely discouraged.
 *
 * Resolved on every read rather than once at boot, because the credential is a
 * projected volume the kubelet owns and a value captured at start is a value
 * that stops being true when the deployment re-renders it.
 */
export async function resolveManifest(
  manifest: AuthoredManifest,
  env: Env = Bun.env,
): Promise<InstallationManifest> {
  return {
    ...manifest,
    cloud: {
      ...manifest.cloud,
      federation: await loadDeploymentFederation(env),
    },
  };
}

/**
 * Refuse to enable header authentication without its non-bypassable boundary.
 *
 * The process cannot observe a Kubernetes NetworkPolicy from inside its own
 * pod. The installer chart therefore sets this attestation beside the policy;
 * a manifest copied into an unrestricted deployment fails closed at boot.
 */
export function assertTrustedGatewayBoundary(
  manifest: Pick<InstallationManifest, 'auth'>,
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
  AuthoredManifest,
  GatewayAuthConfig,
  InstallationManifest,
} from './manifest.schema.ts';
