/**
 * Deploys each opted-in App (`apps.autoDeploy`) at the commit its repository
 * just adopted, through {@link deployApp}. Every Component builds from its
 * App's scope, so a push deploys each placed Component to its own Target. The
 * webhook route and the poll loop both call it with the same passes.
 */
import { and, asc, eq, inArray, isNotNull } from 'drizzle-orm';
import { type DeployAppResult, deployApp } from '../commands/apps/deploy.ts';
import type {
  AdapterRegistry,
  Clock,
  CommandResult,
  Principal,
} from '../commands/types.ts';
import type { InstallationManifest } from '../config/manifest.schema.ts';
import type { Database } from '../db/client.ts';
import { apps, components, repositories } from '../db/schema.ts';
import { logWarn } from '../telemetry/index.ts';
import type { RepositoryReconciliation } from './repo-loop.ts';

export const AUTO_DEPLOY_PRINCIPAL: Principal = {
  id: 'spindrift:auto-deploy',
  displayName: 'kthx (auto-deploy on push)',
};

export interface AutoDeployContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly adapters: AdapterRegistry;
  readonly manifest: InstallationManifest;
}

export interface AutoDeployAttempt {
  readonly appId: string;
  readonly componentId: string;
  readonly commit: string;
  readonly result: CommandResult<DeployAppResult>;
}

export interface PlacedComponent {
  readonly id: string;
  readonly placedTargetId: string;
}

/**
 * Names the Component and its Target, so `deployApp` never falls back to the
 * App's oldest Component. A move since the placement was read is refused.
 */
export async function deployComponentAt(
  context: AutoDeployContext,
  appId: string,
  component: PlacedComponent,
  commit: string,
): Promise<AutoDeployAttempt> {
  const result = await deployApp(
    {
      name: appId,
      commit,
      component: component.id,
      target: component.placedTargetId,
    },
    {
      principal: AUTO_DEPLOY_PRINCIPAL,
      clock: context.clock,
      db: context.db,
      adapters: context.adapters,
      manifest: context.manifest,
    },
  );
  return { appId, componentId: component.id, commit, result };
}

/** Each opted-in App's placed Components, oldest first. */
async function placedComponentsOf(
  db: Database,
  appIds: readonly string[],
): Promise<Map<string, Array<PlacedComponent & { readonly name: string }>>> {
  const rows = await db
    .select({
      id: components.id,
      appId: components.appId,
      name: components.name,
      placedTargetId: components.placedTargetId,
    })
    .from(components)
    .where(
      and(
        inArray(components.appId, [...appIds]),
        isNotNull(components.placedTargetId),
      ),
    )
    .orderBy(asc(components.createdAt), asc(components.id));

  const placed = new Map<
    string,
    Array<PlacedComponent & { readonly name: string }>
  >();
  for (const { appId, placedTargetId, ...component } of rows) {
    if (placedTargetId === null) continue;
    placed.set(appId, [
      ...(placed.get(appId) ?? []),
      { ...component, placedTargetId },
    ]);
  }
  return placed;
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
  if (optedIn.size === 0) return [];

  // An unplaced Component has no Target for a push to deploy it to.
  const placed = await placedComponentsOf(context.db, [...optedIn.keys()]);

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
          'kthx.engine.app.id': scope.appId,
          'kthx.engine.app.name': app.name,
          'kthx.engine.repository': pass.fullName,
          'kthx.engine.commit': pass.commit,
          'kthx.engine.lock.reason': app.lockReason,
        });
        continue;
      }
      for (const component of placed.get(app.id) ?? []) {
        const attempt = await deployComponentAt(
          context,
          app.id,
          component,
          pass.commit,
        );
        if (!attempt.result.ok) {
          // Logged: both callers discard the return value, and a refused push
          // has no Build row to carry the reason.
          logWarn('a push was adopted and its deploy was refused', {
            'kthx.engine.app.id': scope.appId,
            'kthx.engine.component.id': component.id,
            'kthx.engine.component.name': component.name,
            'kthx.engine.target.id': component.placedTargetId,
            'kthx.engine.repository': pass.fullName,
            'kthx.engine.commit': pass.commit,
            'kthx.engine.refusal.code': attempt.result.failure.code,
            'kthx.engine.refusal.message': attempt.result.failure.message,
          });
        }
        attempts.push(attempt);
      }
    }
  }
  return attempts;
}
