/**
 * The dispatcher `repo-loop.ts` left for later (§15).
 *
 * That file's header says why it stops at adopting a commit: reconciliation
 * only has a `RepositoryReconciliation` to report, and a Deploy is a decision
 * about an App, not about a repository. This module is the other half — it
 * reads what a pass adopted and, for every App on that repository that has
 * opted in (`apps.autoDeploy`), calls {@link deployApp}: the same one-button
 * command a developer reaches from the workspace. A push causes exactly what
 * pressing that button would, nothing more — this module writes no row of its
 * own and invents no second admission policy.
 *
 * **Opt-in is a property of the App, not of the delivery.** A repository can
 * carry Apps that watch it silently beside Apps that redeploy on every push,
 * which is why this reads `apps.autoDeploy` per scope rather than a flag on
 * the repository or on the webhook route.
 *
 * **Called from both the webhook route and the poll loop's periodic pass,
 * over the same `RepositoryReconciliation[]`.** Neither path is a second
 * dispatcher — both hand their passes here, which is what keeps a missed
 * delivery self-healing: the loop's next tick reconciles the same commit and
 * dispatches exactly as the webhook would have (§15: "a missed delivery
 * self-heals").
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
import { apps } from '../db/schema.ts';
import type { RepositoryReconciliation } from './repo-loop.ts';

/**
 * Attributed to every push-triggered Deploy: nobody was at the keyboard, and
 * §"First run and identity" gives every enrolled user one fully privileged
 * kind rather than a role this dispatcher could borrow instead.
 */
export const AUTO_DEPLOY_PRINCIPAL: Principal = {
  id: 'spindrift:auto-deploy',
  displayName: 'Spindrift (auto-deploy on push)',
};

/** What `dispatchAutoDeploys` needs — a `CommandContext` minus the principal. */
export interface AutoDeployContext {
  readonly db: Database;
  readonly clock: Clock;
  readonly adapters: AdapterRegistry;
  readonly manifest: InstallationManifest;
}

/** One opted-in App's dispatch, so a caller can log or assert on it. */
export interface AutoDeployAttempt {
  readonly appId: string;
  readonly result: CommandResult<DeployAppResult>;
}

/**
 * Deploy every opted-in App whose repository just adopted a new commit.
 *
 * Only `outcome: 'adopted'` passes carry a new commit — `unchanged`, `frozen`,
 * `rejected`, and `unavailable` all mean nothing landed, so there is nothing
 * to redeploy. `invalid` scopes never appear beside an `adopted` outcome
 * (repo-loop.ts refuses the whole commit when one does), so every scope this
 * reads named a real App.
 */
export async function dispatchAutoDeploys(
  context: AutoDeployContext,
  passes: readonly RepositoryReconciliation[],
): Promise<readonly AutoDeployAttempt[]> {
  const appIds = passes
    .filter((pass) => pass.outcome === 'adopted')
    .flatMap((pass) => pass.scopes.map((scope) => scope.appId));
  if (appIds.length === 0) return [];

  const optedIn = await context.db
    .select({ id: apps.id })
    .from(apps)
    .where(and(inArray(apps.id, appIds), eq(apps.autoDeploy, true)));

  const attempts: AutoDeployAttempt[] = [];
  for (const app of optedIn) {
    const result = await deployApp(
      { name: app.id },
      {
        principal: AUTO_DEPLOY_PRINCIPAL,
        clock: context.clock,
        db: context.db,
        adapters: context.adapters,
        manifest: context.manifest,
      },
    );
    attempts.push({ appId: app.id, result });
  }
  return attempts;
}
