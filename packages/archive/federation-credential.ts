/**
 * Federation settings, read from the `external_account` credential the chart
 * mounts so that no manifest repeats them.
 */
import { z } from 'zod';
import type { FederationConfig } from './federation.ts';

/** Google's ADC variable, so every client in the process finds this file. */
export const GCP_CREDENTIALS_VAR = 'GOOGLE_APPLICATION_CREDENTIALS';

/** The named credential file is missing or unusable. */
export class FederationCredentialError extends Error {
  override readonly name = 'FederationCredentialError';
}

/**
 * Not strict: a third-party format may add fields. `type` is checked because a
 * service account key file, which is never allowed here, would otherwise parse.
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
 * `null` when no credential is named, which means no cloud access. A named file
 * that is missing throws: a broken mount is not the same as no cloud.
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

/** Exported so a test needs no file on disk. */
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
    // The pool-audience projected token, not the default service account
    // token, which a cloud API refuses.
    tokenPath: credential.credential_source.file,
    impersonationUrl: credential.service_account_impersonation_url ?? null,
  };
}

export type { FederationConfig };
