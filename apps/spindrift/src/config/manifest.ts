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
  installation: {
    name: 'default',
    controlPlaneVessel: 'primary',
    homeVessel: 'spindrift',
  },
  controlPlane: {
    hostname: 'spindrift.example.com',
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
     * `spindrift.example.com` is — it is a foreign repository handed the
     * build of every repo an unseeded installation connects. Null makes the
     * gap loud: connect refuses until an operator states a real workflow.
     */
    buildWorkflow: null,
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
 * **The three values below and not the whole document**, which is the difference
 * between a predicate with a reachable `true` and one without. The manifest is
 * three kinds of value: deployment facts the chart already knows, cloud facts
 * discovery can ask for, and the genuine choices — what this installation is
 * called, where its artifacts are published, and
 * which store it delivers config through. Comparing the *whole* document made
 * `true` reachable for exactly one document, the placeholder verbatim, and that
 * document names `spindrift.example.com` as its control plane. `serve.ts` binds
 * the passkey relying party to that hostname at boot, so a browser refuses every
 * ceremony against it and nobody can sign in — and onboarding renders only after
 * a session exists. A predicate whose one `true` sits behind a door that cannot
 * open is a wizard nobody can be shown.
 *
 * **What that actually makes reachable, and it is now the ordinary case.** A
 * declaration carrying a real `controlPlane.hostname` with these three left at
 * their stand-ins answers `true` and *can* enrol somebody, so the reachable set
 * is no longer empty. It is not a document anybody writes by accident: nothing
 * in `installationManifestSchema` is optional, so an operator cannot **leave**
 * the genuine choices — every key must be authored — and the values one would
 * have to type to stay unconfigured are `installation: default`,
 * somebody else's GHCR namespace and
 * `onepassword`. What makes the wizard ordinarily reachable is the chart seeding
 * the deployment facts it already holds, `controlPlane.hostname` above all, so
 * that the *placeholder* — what an installation with no declaration at all is
 * seeded with — is itself an installation a browser will run a ceremony
 * against: a bare `manifest: {}` release with a `hostname` renders
 * `files/default-manifest.yaml` (`packages/charts/spindrift`) in place of the
 * stored row's fallback, and that document is this same
 * `DEFAULT_PLACEHOLDER_MANIFEST` with `controlPlane.hostname` bound to the
 * release's own instead of `spindrift.example.com`. A seeded declaration and a
 * bare `manifest: {}` install both reach the wizard now; only a release with
 * neither a declaration nor a `hostname` — in-cluster-only, nothing to bind a
 * relying party to — still cannot.
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
/**
 * The mounted declaration where it governs, and `null` where it does not.
 *
 * **A stand-in governs nothing.** The governed slice
 * (`manifest-store.ts:governedByDeclaration`) exists so a rollout cannot revert
 * the two vessels an installation is built on: a control plane pointed at a
 * boundary that is not there, or a home vessel whose bucket and signer nobody
 * can reach, is an installation that cannot come back, and that is worth taking
 * out of the operator's hands. **None of that reasoning survives the document
 * being the placeholder.** There is no operator assertion to protect, and what
 * the rule protects instead is `spindrift-vessel` and `spindrift-artifacts` —
 * names of nothing — against the real ones, forever, because the wizard that
 * would set them is refused for editing a governed path.
 *
 * That is not a hypothetical: the chart mounts exactly this document on a
 * release with no `manifest:` value, which is the chart-only install path, and
 * the two collided the first time anybody ran one. The relying party is why the
 * chart mounts it at all — see `files/default-manifest.yaml` — so the document
 * has to stay mounted and stop governing, rather than not be mounted.
 *
 * The same three keys as {@link isUnconfiguredInstallation}, and deliberately
 * the same function: "this document is the stand-in" is one fact, and a second
 * spelling of it is a second thing to keep in step with the chart's copy.
 */
export function governingDeclaration(
  declaration: AuthoredManifest | null | undefined,
): AuthoredManifest | null {
  if (declaration == null) return null;
  return isUnconfiguredInstallation(declaration) ? null : declaration;
}

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
    cloud: { federation: await loadDeploymentFederation(env) },
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
