const SENSITIVE_HEADERS = [
  'authorization',
  'x-vercel-oidc-token',
  'x-github-token',
  'x-gitlab-token',
  'x-bitbucket-token',
  'x-azure-devops-token',
  'x-aws-secret-key',
  'x-aws-access-key',
] as const;

const SENSITIVE_HEADER_PLACEHOLDER = '[redacted]';

const SENSITIVE_ENV_VARS = [
  'VERCEL_OIDC_TOKEN',
  'EDGE_CONFIG',
  'BLOB_READ_WRITE_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'BITBUCKET_TOKEN',
  'AZURE_DEVOPS_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'DATABASE_URL',
  'DATABASE_PASSWORD',
  'DB_PASSWORD',
  'SECRET',
  'SECRET_KEY',
  'API_KEY',
  'PRIVATE_KEY',
  'ACCESS_TOKEN',
  'REFRESH_TOKEN',
  'PASSWORD',
] as const;

const SENSITIVE_ENV_PLACEHOLDER = '[redacted]';

export function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    const normalizedKey = key.toLowerCase();

    if (
      SENSITIVE_HEADERS.includes(
        normalizedKey as (typeof SENSITIVE_HEADERS)[number],
      )
    ) {
      sanitized[key] = SENSITIVE_HEADER_PLACEHOLDER;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

export function sanitizeEnvVars(
  envVars: Record<string, string>,
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(envVars)) {
    const upperKey = key.toUpperCase();

    // NEXT_PUBLIC_* values already ship in the client bundle.
    if (upperKey.startsWith('NEXT_PUBLIC_')) {
      sanitized[key] = value;
      continue;
    }

    const isSensitive = SENSITIVE_ENV_VARS.some(
      (sensitiveKey) => upperKey === sensitiveKey.toUpperCase(),
    );

    const containsSensitivePattern =
      upperKey.endsWith('_TOKEN') ||
      upperKey.includes('_TOKEN_') ||
      upperKey.endsWith('_SECRET') ||
      upperKey.includes('_SECRET_') ||
      upperKey.endsWith('_PASSWORD') ||
      upperKey.includes('_PASSWORD_') ||
      (upperKey.endsWith('_KEY') && !upperKey.includes('PUBLIC')) ||
      (upperKey.includes('_KEY_') && !upperKey.includes('PUBLIC')) ||
      upperKey.endsWith('_PRIVATE_KEY') ||
      upperKey.includes('_PRIVATE_KEY_');

    if (isSensitive || containsSensitivePattern) {
      sanitized[key] = SENSITIVE_ENV_PLACEHOLDER;
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}
