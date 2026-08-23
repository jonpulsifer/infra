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

/**
 * Deployment attestation set by the chart only when it renders a default-deny
 * NetworkPolicy admitting the configured trusted Gateway peers.
 */
export const TRUSTED_GATEWAY_BOUNDARY_VAR =
  'SPINDRIFT_TRUSTED_GATEWAY_BOUNDARY';

/**
 * Where this deployment serves the control plane. Set by the chart from the
 * same `hostname` value that renders the Gateway and the HTTPRoute.
 */
export const HOSTNAME_VAR = 'SPINDRIFT_HOSTNAME';

/**
 * What this deployment is running. The same variable `telemetry/index.ts`
 * reports as `service.version`, read here so the UI and the traces name one
 * thing; unset is `null` rather than telemetry's placeholder.
 */
export const VERSION_VAR = 'SPINDRIFT_VERSION';

/**
 * The relying party of a deployment that serves no origin.
 *
 * An installation reachable only in-cluster renders no Gateway and no
 * HTTPRoute, and the chart says that is supported — but a passkey ceremony
 * still has to be scoped to something, and there is nothing true to scope it
 * to. This is the honest stand-in: a browser refuses a ceremony against it, so
 * that installation cannot enrol anybody, which is the same thing the missing
 * origin already meant. It is named here rather than spelled inline so the one
 * unreachable configuration is one value, findable.
 */
export const UNSERVED_HOSTNAME = 'spindrift.example.com';

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

/** High-trust default placeholder manifest used when initializing an unseeded installation. */
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
    /**
     * Null, never a placeholder ref. `connectRepository` writes this value
     * into a caller workflow inside somebody's repository, so a stand-in
     * `owner/repo@sha` here is not inert scaffolding the way
     * `spindrift-vessel` is — it is a foreign repository handed the
     * build of every repo an unseeded installation connects. Null makes the
     * gap loud: connect refuses until an operator states a real workflow.
     */
    buildWorkflow: null,
  },
  build: {
    routes: [{ name: 'github', adapter: 'github-actions' }],
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
 * Whether nobody has configured this installation yet.
 *
 * **Derived, not flagged**, and that is the whole of the design. `loadStoredManifest`
 * resolves `stored ?? declaration ?? placeholder` and then writes whichever arm
 * it took back to the row — so by the time anything can ask the question, the
 * placeholder arm is no longer distinguishable by *when* it was taken, only by
 * *what it wrote*. A boolean column recording which arm ran would be a second
 * copy of a fact the row already carries whole, and it would go stale the first
 * time somebody edited the row by hand or restored a database.
 *
 * **The three values below and not the whole document.** The manifest is three
 * kinds of value: deployment facts the deployment itself supplies, cloud facts
 * discovery can ask for, and the genuine choices — what this installation is
 * called, where its artifacts are published, and which store it delivers config
 * through. Only the third kind is a question, so only the third kind decides
 * whether anybody has answered one.
 *
 * **Reachable by construction, now that the relying party is a deployment
 * fact.** Every installation resolves `controlPlane.hostname` from the
 * deployment that serves it, so an unconfigured one is served at its own real
 * origin and a browser will run a ceremony against it. That is what makes this
 * predicate answerable rather than academic: onboarding renders only after a
 * session exists, and until the hostname moved out of the document, the one
 * document this answered `true` for named `spindrift.example.com` and could
 * enrol nobody. The only installation that still cannot is the one with no
 * origin at all — in-cluster-only, nothing to bind a relying party to — and
 * that is the missing Gateway saying so, not this.
 *
 * It is not a state anybody reaches by accident either: nothing in
 * `installationManifestSchema` is optional, so an operator cannot **leave** the
 * genuine choices — every key must be authored — and the values one would have
 * to type to stay unconfigured are `installation: default`, somebody else's
 * GHCR namespace, and `onepassword`.
 *
 * **All three, not any**, and a false positive here replaces the whole product
 * with a wizard, so the direction matters. One of the three is legitimately the
 * stand-in on a configured installation — `onepassword` is one of two
 * adapters — so "any is a stand-in" would answer unconfigured for a live
 * installation. `test/config/installation-configured.test.ts` pins the live
 * document against this.
 *
 * **A mounted declaration that answers all three therefore configures an
 * installation**, which is right: an operator who chose them has configured this
 * installation by definition, and offering them onboarding would be offering to
 * redo work they already did.
 *
 * The named cost: an operator who confirms all three unchanged is still
 * unconfigured, and will be shown onboarding again on the next load. That is
 * honest — they chose nothing — but it does mean "configured" is a record of a
 * document, not of a ceremony.
 */
export function isUnconfiguredInstallation(
  manifest: AuthoredManifest,
): boolean {
  const stand = DEFAULT_PLACEHOLDER_MANIFEST;
  // Three genuine choices, not four: the GitHub App identity used to be one of
  // them (`github.clientId`), but it now lives in the `github_app` row, written
  // by the manifest-flow conversion rather than authored here — so the manifest
  // carries no key that could answer it.
  return (
    manifest.installation.name === stand.installation.name &&
    manifest.secretStore.adapter === stand.secretStore.adapter &&
    // The one that is a list. A bare string is the same document as a
    // one-element list by the time it is parsed (`manifest.schema.ts`), so both
    // sides are arrays here and neither spelling changes the answer.
    Bun.deepEquals(manifest.supplyChain.registry, stand.supplyChain.registry)
  );
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
    cloud: { federation: await loadDeploymentFederation(env) },
    boundary: { trustedGateway: env[TRUSTED_GATEWAY_BOUNDARY_VAR] === 'true' },
    controlPlane: {
      hostname: env[HOSTNAME_VAR]?.trim() || UNSERVED_HOSTNAME,
      version: env[VERSION_VAR]?.trim() || null,
    },
  };
}

/**
 * The sentence refusing header authentication without its non-bypassable
 * boundary, or `null` for a document this deployment can serve.
 *
 * The process cannot observe a Kubernetes NetworkPolicy from inside its own
 * pod. The installer chart therefore sets an attestation beside the policy,
 * which {@link resolveManifest} joins on as `boundary.trustedGateway`; a
 * manifest copied into an unrestricted deployment fails closed.
 *
 * **A sentence rather than a throw, because two callers need it at two
 * moments.** Boot is fatal — an installation that cannot honour what its own
 * document says about authentication has nothing honest to serve — but
 * `configureInstallation` is an operator pressing Save, and there the same fact
 * is a refusal to read rather than a pod that stops coming back. Until it was
 * both, a wizard could write `auth.gateway` on a deployment with no policy and
 * wedge the web process at its next restart.
 */
export function trustedGatewayRefusal(
  manifest: Pick<InstallationManifest, 'auth' | 'boundary'>,
): string | null {
  if (manifest.auth.gateway === null || manifest.boundary.trustedGateway) {
    return null;
  }
  return `auth.gateway requires ${TRUSTED_GATEWAY_BOUNDARY_VAR}=true from a deployment that strips identity headers and restricts ingress to the trusted Gateway`;
}

/** {@link trustedGatewayRefusal} at boot, where it is fatal. */
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
