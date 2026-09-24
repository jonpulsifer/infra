import { PageHeader } from '@/components/page-header';
import { sanitizeEnvVars } from '@/lib/sanitize-headers';
import Environment from './_components/environment';

export default async function EnvironmentPage() {
  const VERCEL_SYSTEM_VARIABLES = [
    'VERCEL',
    'VERCEL_ENV',
    'VERCEL_URL',
    'VERCEL_REGION',
    'VERCEL_BRANCH_URL',
    'VERCEL_PROJECT_PRODUCTION_URL',
    'VERCEL_AUTOMATION_BYPASS_SECRET',
    'VERCEL_GIT_PROVIDER',
    'VERCEL_GIT_REPO_SLUG',
    'VERCEL_GIT_REPO_OWNER',
    'VERCEL_GIT_REPO_ID',
    'VERCEL_GIT_COMMIT_REF',
    'VERCEL_GIT_COMMIT_SHA',
    'VERCEL_GIT_COMMIT_MESSAGE',
    'VERCEL_GIT_COMMIT_AUTHOR_LOGIN',
    'VERCEL_GIT_COMMIT_AUTHOR_NAME',
    'VERCEL_GIT_PULL_REQUEST_ID',
  ];

  // NEXT_PUBLIC_* variables belong to the client tab, read in the browser.
  const allServerEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => !key.startsWith('NEXT_PUBLIC_'))
      .filter(([_, value]) => value !== undefined),
  ) as Record<string, string>;

  const serverEnv: Record<string, string> = { ...allServerEnv };
  VERCEL_SYSTEM_VARIABLES.forEach((key) => {
    if (process.env[key] !== undefined) {
      serverEnv[key] = process.env[key]!;
    }
  });

  const sortedServerEnv = Object.fromEntries(
    Object.entries(serverEnv).sort(([a], [b]) => a.localeCompare(b)),
  );

  const sanitizedServerEnv = sanitizeEnvVars(sortedServerEnv);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 pt-0">
      <PageHeader
        title="Environment Variables"
        description="View server and client environment variables"
      />
      <Environment serverEnv={sanitizedServerEnv} />
    </div>
  );
}
