/**
 * The dispatcher `repo-loop.ts` left for later (§15).
 *
 * That file's header says why it stops at adopting a commit: reconciliation
 * only has a `RepositoryReconciliation` to report, and a Deploy is a decision
 * about an App, not about a repository. This module is the other half — it
 * reads what a pass adopted and, for every App on that repository that has
 * opted in (`apps.autoDeploy`), calls {@link deployApp}: the same one-button
 * command a developer reaches from the workspace. This module writes no row of
 * its own and invents no second admission policy — one `checkDeployable`, one
 * `placeIntent`, no second gate.
 *
 * **What it does not borrow from the button is which act.** A press carries no
 * commit; a push carries one, and `deployApp`'s first branch — deploy what is
 * already built — is only the right act when what is already built *is* this
 * commit. Reading "a push causes exactly what pressing that button would" as
 * covering the act as well as the policy is what made a push to a healthy App
 * redeploy the previous commit's artifact and never build the pushed one at
 * all. So every dispatch here names `commit`, and `deployApp` decides against
 * it: build it, deploy it, or — where this commit is already what is desired —
 * do nothing and say so.
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
import { apps, repositories } from '../db/schema.ts';
import { logWarn } from '../telemetry/index.ts';
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
  /** The adopted commit this dispatch was for. */
  readonly commit: string;
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
  // Walked per pass rather than flat-mapped into one id list, because the
  // commit is the point: two repositories reconciling in one round adopt two
  // different commits, and an App has to be dispatched with the one its own
  // repository adopted.
  const adopted = passes.filter((pass) => pass.outcome === 'adopted');
  const appIds = adopted.flatMap((pass) =>
    pass.scopes.map((scope) => scope.appId),
  );
  if (appIds.length === 0) return [];

  const optedIn = new Set(
    (
      await context.db
        .select({ id: apps.id })
        .from(apps)
        .where(and(inArray(apps.id, appIds), eq(apps.autoDeploy, true)))
    ).map((app) => app.id),
  );

  // **What still governs, read now rather than when the pass was taken.** The
  // poll loop reconciles the whole fleet before it dispatches any of it, so a
  // pass can be minutes old by the time it arrives here — old enough for the
  // webhook, in another process, to have adopted a newer commit and dispatched
  // it already. Building the older commit anyway would place it *after* the
  // newer one, which is a rollback nobody asked for. §15 makes
  // `authoritative_commit` the thing that governs, so a pass that no longer
  // agrees with it has been overtaken and its work is already being done.
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
      if (!optedIn.has(scope.appId)) continue;
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
        // Both callers discard what this function returns — the webhook route
        // answers 202 and the poll loop moves on — so a refusal that only
        // travelled in the return value reached nobody. It is said here rather
        // than at each call site because there is no Build row to write it
        // onto: the acts that would create one are exactly the acts being
        // refused. An installation with no source depot, a Target that was
        // disconnected since the last push, a signature that no longer
        // verifies — each of those now answers a push with a sentence
        // somewhere rather than with silence.
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
