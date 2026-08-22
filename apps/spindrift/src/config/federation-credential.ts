/**
 * §13's federation, read from the credential this deployment mounts.
 *
 * The installer chart writes an `external_account` credential document from the
 * workload-identity audience and mount path a release names, and points
 * `GOOGLE_APPLICATION_CREDENTIALS` at it. Every fact federation needs is
 * already in that document: the pool provider this cluster's tokens are trusted
 * by, where a projected token is exchanged, where that token is read from, and
 * which service account is impersonated with the result.
 *
 * **So the manifest does not ask for them a second time.** §20's rule is
 * "everything naming this installation is a value in the installation manifest;
 * a literal outside it is a bug", and the rule is enforced as a grep — which a
 * value living in *both* the chart and the manifest satisfies while still being
 * able to disagree with itself. When it disagreed, the failure surfaced as an
 * `iam.serviceAccounts.signBlob` refusal that read as a code defect for a whole
 * session. There is one copy now, and it is the one the pod is holding.
 *
 * `null` — no credential mounted — stays a supported installation, for exactly
 * the reason `cloud.federation` was nullable when it was authored: an
 * installation with no cloud Targets has no honest value here, and a
 * placeholder would be a configuration that looks complete and fails on the
 * first deploy. Null means cloud Targets cannot be reached, and nothing else
 * changes.
 *
 * Read on every resolution rather than captured once, for the same reason
 * `federation.ts` re-reads the projected token: the file is a projected volume
 * the kubelet owns, and a value captured at boot is a value that stops being
 * true the moment the credential is re-rendered.
 */
import { z } from 'zod';
import type { FederationConfig } from '../adapters/deploy/cloud/federation.ts';

/**
 * Where the credential document is. The name is Google's own ADC variable, not
 * this software's: it names no installation, and the chart sets it beside the
 * mount so that any client in the process — this one included — finds the same
 * credential.
 */
export const GCP_CREDENTIALS_VAR = 'GOOGLE_APPLICATION_CREDENTIALS';

/** Raised when a mounted credential is present and unusable. */
export class FederationCredentialError extends Error {
  override readonly name = 'FederationCredentialError';
}

/**
 * An `external_account` credential document, as far as federation reads it.
 *
 * Not `.strict()`: this is a third party's format and a document carrying a
 * field this code does not read is a valid credential, not a broken one.
 * `type` is checked because a *service account key* file would parse against
 * everything else and is the one thing §13 forbids being here at all.
 */
const externalAccountSchema = z.object({
  type: z.literal('external_account'),
  audience: z.string().trim().min(1),
  token_url: z.url(),
  credential_source: z.object({
    file: z
      .string()
      .trim()
      .regex(/^\//, 'must be an absolute path inside the pod'),
  }),
  service_account_impersonation_url: z.url().optional(),
});

type Env = Record<string, string | undefined>;

/**
 * The federation this deployment declares, or `null` when it declares none.
 *
 * A credential named and absent is an error rather than a `null`: a broken
 * mount is not the same state as no cloud at all, and silently becoming an
 * installation with no cloud Targets is how a deploy fails for a reason nobody
 * can act on.
 */
export async function loadDeploymentFederation(
  env: Env = Bun.env,
): Promise<FederationConfig | null> {
  const path = env[GCP_CREDENTIALS_VAR]?.trim();
  if (!path) return null;

  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new FederationCredentialError(
      `${GCP_CREDENTIALS_VAR}=${path}: no such file, so this installation declares a cloud credential it does not mount`,
    );
  }

  return parseFederationCredential(await file.text(), path);
}

/** Parse one credential document. Exported so a test needs no file on disk. */
export function parseFederationCredential(
  document: string,
  source: string,
): FederationConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(document);
  } catch (cause) {
    throw new FederationCredentialError(
      `${source}: not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const result = externalAccountSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const path = issue.path.join('.');
        return `  ${path === '' ? '(root)' : path}: ${issue.message}`;
      })
      .join('\n');
    throw new FederationCredentialError(
      `${source}: not a usable external_account credential\n${issues}`,
    );
  }

  const credential = result.data;
  return {
    audience: credential.audience,
    tokenUrl: credential.token_url,
    // The document's `credential_source.file` is the separately projected
    // volume whose audience is the pool — never the default service account
    // token, which is minted for this cluster's own API server and which a
    // cloud API refuses. The chart projects both and names this one here.
    tokenPath: credential.credential_source.file,
    // Absent is a supported configuration rather than an omission: direct
    // resource access grants the federated identity roles on its own, which is
    // one fewer identity to reason about where the cloud resources allow it.
    impersonationUrl: credential.service_account_impersonation_url ?? null,
  };
}

export type { FederationConfig };
