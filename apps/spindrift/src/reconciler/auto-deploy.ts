/**
 * Deploys each opted-in App (`apps.autoDeploy`) at the commit its repository
 * just adopted, through {@link deployApp}. The webhook route and the poll loop
 * both call it with the same passes.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { type DeployAppResult, deployApp } from '../commands/apps/deploy.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandResult,
  Principal,
} from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { apps, repositories } from '../db/schema.ts';
import { logWarn } from '../telemetry/index.ts';
import type { RepositoryReconciliation } from './repo-loop.ts';

export const AUTO_DEPLOY_PRINCIPAL: Principal = {
  id: 'spindrift:auto-deploy',
  displayName: 'Spindrift (auto-deploy on push)',
};

export interface AutoDeployContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly adapters: AdapterRegistry;
  readonly manifest: InstallationManifest;
}

export interface AutoDeployAttempt {
  readonly appId: string;
  readonly commit: string;
  readonly result: CommandResult<DeployAppResult>;
}

export async function dispatchAutoDeploys(
  context: AutoDeployContext,
  passes: readonly RepositoryReconciliation[],
): Promise<readonly AutoDeployAttempt[]> {
  // Only an adopted pass carries a new commit, and its scopes all name real
  // Apps: one invalid scope refuses the whole commit.
  const adopted = passes.filter((pass) => pass.outcome === 'adopted');
  const appIds = adopted.flatMap((pass) =>
    pass.scopes.map((scope) => scope.appId),
  );
  if (appIds.length === 0) return [];

  const optedIn = new Map(
    (
      await context.db
        .select({ id: apps.id, name: apps.name, lockReason: apps.lockReason })
        .from(apps)
        .where(and(inArray(apps.id, appIds), eq(apps.autoDeploy, true)))
    ).map((app) => [app.id, app]),
  );

  // Read now: a poll pass can be minutes old, and the webhook may have adopted
  // a newer commit since. Deploying the overtaken one would be a rollback.
  const governing = new Map(
    (
      await context.db
        .select({
          id: repositories.id,
          commit: repositories.authoritativeCommit,
        })
        .from(repositories)
        .where(
          inArray(
            repositories.id,
            adopted.map((pass) => pass.repositoryId),
          ),
        )
    ).map((row) => [row.id, row.commit]),
  );

  const attempts: AutoDeployAttempt[] = [];
  for (const pass of adopted) {
    if (governing.get(pass.repositoryId) !== pass.commit) continue;
    for (const scope of pass.scopes) {
      const app = optedIn.get(scope.appId);
      if (app === undefined) continue;
      // Skipped before anything builds, so a lock spends no CI minutes on a
      // deploy it would refuse.
      if (app.lockReason !== null) {
        logWarn('a push was adopted and its App is locked', {
          'spindrift.app.id': scope.appId,
          'spindrift.app.name': app.name,
          'spindrift.repository': pass.fullName,
          'spindrift.commit': pass.commit,
          'spindrift.lock.reason': app.lockReason,
        });
        continue;
      }
      const result = await deployApp(
        { name: scope.appId, commit: pass.commit },
        {
          principal: AUTO_DEPLOY_PRINCIPAL,
          clock: context.clock,
          db: context.db,
          adapters: context.adapters,
          manifest: context.manifest,
        },
      );
      if (!result.ok) {
        // Logged: both callers discard the return value, and a refused push
        // has no Build row to carry the reason.
        logWarn('a push was adopted and its deploy was refused', {
          'spindrift.app.id': scope.appId,
          'spindrift.repository': pass.fullName,
          'spindrift.commit': pass.commit,
          'spindrift.refusal.code': result.failure.code,
          'spindrift.refusal.message': result.failure.message,
        });
      }
      attempts.push({ appId: scope.appId, commit: pass.commit, result });
    }
  }
  return attempts;
}
