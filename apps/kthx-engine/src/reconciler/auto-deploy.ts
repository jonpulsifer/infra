/**
 * Deploys each opted-in App (`apps.autoDeploy`) at the commit its repository
 * just adopted, through {@link deployApp}. Every Component builds from its
 * App's scope, so a push deploys each placed Component to its own Target. The
 * webhook route and the poll loop both call it with the same passes.
 */
import type { Attributes } from '@opentelemetry/api';
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
import { logError, logWarn } from '../telemetry/index.ts';
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

/** `deployApp`'s answer, or `fault` when it threw. */
export type AutoDeployAttempt = {
  readonly appId: string;
  readonly componentId: string;
  readonly commit: string;
} & (
  | {
      readonly result: CommandResult<DeployAppResult>;
      readonly fault?: undefined;
    }
  | { readonly result?: undefined; readonly fault: string }
);

export interface PlacedComponent {
  readonly id: string;
  readonly name: string;
  readonly placedTargetId: string;
}

/**
 * Names the Component and its Target, which `deployApp` needs once an App has
 * several Components. A move since the placement was read is refused. A
 * refusal or a fault is logged here and returned, never thrown, so the caller
 * goes on to the next Component.
 */
export async function deployComponentAt(
  context: AutoDeployContext,
  appId: string,
  component: PlacedComponent,
  commit: string,
  attributes: Attributes = {},
): Promise<AutoDeployAttempt> {
  const facts = {
    ...attributes,
    'kthx.engine.app.id': appId,
    'kthx.engine.component.id': component.id,
    'kthx.engine.component.name': component.name,
    'kthx.engine.target.id': component.placedTargetId,
    'kthx.engine.commit': commit,
  };
  const attempt = { appId, componentId: component.id, commit };
  try {
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
    if (!result.ok) {
      // Logged: the push callers discard the return value, and a refused push
      // has no Build row to carry the reason.
      logWarn('a push was adopted and its deploy was refused', {
        ...facts,
        'kthx.engine.refusal.code': result.failure.code,
        'kthx.engine.refusal.message': result.failure.message,
      });
    }
    return { ...attempt, result };
  } catch (cause) {
    // The adopted commit is never dispatched again, so a throw here would
    // strand every Component after this one until the next push.
    logError('a push was adopted and its deploy failed', cause, facts);
    return {
      ...attempt,
      fault: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

/** Each opted-in App's placed Components, oldest first. */
async function placedComponentsOf(
  db: Database,
  appIds: readonly string[],
): Promise<Map<string, PlacedComponent[]>> {
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

  const placed = new Map<string, PlacedComponent[]>();
  for (const { appId, placedTargetId, ...component } of rows) {
    if (placedTargetId === null) continue;
    placed.set(appId, [
      ...(placed.get(appId) ?? []),
      { ...component, placedTargetId },
    ]);
  }
  return placed;
}

/**
 * The repository's governing commit and the App's lock, as they stand now.
 * `undefined` when the App is no longer in that repository.
 */
export async function currentStateOf(
  db: Database,
  repositoryId: string,
  appId: string,
) {
  const [row] = await db
    .select({
      commit: repositories.authoritativeCommit,
      lockReason: apps.lockReason,
    })
    .from(apps)
    .innerJoin(repositories, eq(repositories.id, apps.repositoryId))
    .where(and(eq(apps.id, appId), eq(repositories.id, repositoryId)))
    .limit(1);
  return row;
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
        .select({ id: apps.id, name: apps.name })
        .from(apps)
        .where(and(inArray(apps.id, appIds), eq(apps.autoDeploy, true)))
    ).map((app) => [app.id, app]),
  );
  if (optedIn.size === 0) return [];

  // An unplaced Component has no Target for a push to deploy it to.
  const placed = await placedComponentsOf(context.db, [...optedIn.keys()]);

  const attempts: AutoDeployAttempt[] = [];
  for (const pass of adopted) {
    scopes: for (const scope of pass.scopes) {
      const app = optedIn.get(scope.appId);
      if (app === undefined) continue;
      for (const component of placed.get(app.id) ?? []) {
        // Read before each Component, because staging one can take long
        // enough for the webhook to adopt a newer commit. Deploying the
        // overtaken one would be a rollback.
        const now = await currentStateOf(context.db, pass.repositoryId, app.id);
        if (now === undefined) continue scopes;
        if (now.commit !== pass.commit) break scopes;
        // Skipped before anything builds, so a lock spends no CI minutes on a
        // deploy it would refuse.
        if (now.lockReason !== null) {
          logWarn('a push was adopted and its App is locked', {
            'kthx.engine.app.id': app.id,
            'kthx.engine.app.name': app.name,
            'kthx.engine.repository': pass.fullName,
            'kthx.engine.commit': pass.commit,
            'kthx.engine.lock.reason': now.lockReason,
          });
          continue scopes;
        }
        attempts.push(
          await deployComponentAt(context, app.id, component, pass.commit, {
            'kthx.engine.repository': pass.fullName,
          }),
        );
      }
    }
  }
  return attempts;
}
