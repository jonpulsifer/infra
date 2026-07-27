/**
 * `connectTarget` — the admin act that registers where things can be deployed
 * (§13).
 *
 * Two rules from §13 shape everything here, and both are the opposite of what a
 * connect flow usually does:
 *
 * **Connect always succeeds.** There is no reachability gate. A cluster that is
 * down, a project with no OIDC trust, an adapter this installation does not have
 * — every one of them produces a Target, in an unhealthy state, with the unmet
 * checklist items and the sentence behind each. §13: "health is a standing
 * prerequisite checklist... an unmet item makes the Target a non-candidate with
 * a stated reason." A connect that failed would leave the operator with nothing
 * to look at and nothing for the loop to re-check.
 *
 * **The act is credential-shaped though the noun is flat.** Connecting a cloud
 * project registers *both* of that project's Targets — `cloudrun` and `static` —
 * because placement determines artifact shape and a single "Cloud" Target would
 * leave a website ambiguous between the two renderings. That is also why no
 * `Provider` noun exists: the shared thing is an argument to this command.
 *
 * Connect is **idempotent by name**. Re-running it re-inspects, keeps the
 * Target's id and rank, and — if it had been disconnected — re-adopts what it
 * stranded, by asking the adapter to `observe` each orphaned Deploy (§13:
 * "reconnect re-adopts via `observe`").
 */
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { deploys, targets } from '../../db/schema.ts';
import {
  deriveHealth,
  type PrerequisiteResult,
} from '../../domain/capabilities.ts';
import {
  type TargetConnection,
  type TargetHealth,
  targetNames,
} from '../../domain/target.ts';
import { inspectTarget } from '../../reconciler/target-loop.ts';
import { type Command, type CommandContext, ok } from '../types.ts';

/** A stable identifier, unique within the installation (§13). */
const targetName = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    'must be lowercase letters, digits and hyphens',
  );

export const connectTargetInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('kubernetes'),
      name: targetName,
      /** §13's prerequisite is OIDC against this, not a credential for it. */
      apiServer: z.url(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cloud'),
      /** One name; both of the project's Targets are derived from it. */
      name: targetName,
      project: z.string().trim().min(1),
      region: z.string().trim().min(1),
    })
    .strict(),
]);

export type ConnectTargetInput = z.infer<typeof connectTargetInput>;

/** One registered Target, as the operator's confirmation shows it. */
export interface ConnectedTarget {
  readonly id: string;
  readonly name: string;
  readonly adapter: TargetAdapter;
  readonly rank: number;
  readonly health: TargetHealth;
  /** Every checklist item, met or not — §3's grammar of stated reasons. */
  readonly prerequisites: readonly PrerequisiteResult[];
}

export interface ConnectTargetResult {
  /** One entry for a cluster, two for a cloud project (§13). */
  readonly targets: readonly ConnectedTarget[];
  /** Deploys a previous disconnect stranded that are still running (§13). */
  readonly readopted: readonly string[];
}

/** The connection material for one of the Targets this act registers. */
function connectionFor(
  input: ConnectTargetInput,
  adapter: TargetAdapter,
): TargetConnection {
  if (adapter === 'kubernetes') {
    if (input.kind !== 'kubernetes') {
      throw new Error('a cloud project does not register a cluster Target');
    }
    return { adapter, apiServer: input.apiServer };
  }
  if (input.kind !== 'cloud') {
    throw new Error('a cluster does not register a cloud Target');
  }
  return adapter === 'cloudrun'
    ? { adapter, project: input.project, region: input.region }
    : { adapter, project: input.project };
}

export const connectTarget: Command<
  ConnectTargetInput,
  ConnectTargetResult
> = async (input, context) => {
  const now = context.clock.now();
  const registered: ConnectedTarget[] = [];
  const readopted: string[] = [];

  for (const { name, adapter } of targetNames(input.kind, input.name)) {
    const existing = (
      await context.db.select().from(targets).where(eq(targets.name, name))
    )[0];

    // One pass of the same loop §13 runs on a schedule — not a second notion of
    // what "healthy" means that happens to run at connect time.
    const { prerequisites, discovery } = await inspectTarget(
      context,
      name,
      adapter,
    );
    const health = deriveHealth(prerequisites);
    const connection = connectionFor(input, adapter);

    if (existing === undefined) {
      // §13: "Rank is one global ordered list." A new Target joins the end of
      // it — a connect must not silently reorder what an operator already
      // arranged.
      const [{ next } = { next: 0 }] = await context.db
        .select({ next: sql<number>`coalesce(max(${targets.rank}), -1) + 1` })
        .from(targets);
      const [row] = await context.db
        .insert(targets)
        .values({
          name,
          adapter,
          connection,
          health,
          prerequisites,
          discovery,
          inspectedAt: now,
          rank: next,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      registered.push({
        id: row!.id,
        name,
        adapter,
        rank: row!.rank,
        health,
        prerequisites,
      });
      continue;
    }

    const [row] = await context.db
      .update(targets)
      .set({
        connection,
        health,
        prerequisites,
        discovery,
        inspectedAt: now,
        status: 'connected',
        updatedAt: now,
      })
      .where(eq(targets.id, existing.id))
      .returning();

    if (existing.status === 'disconnected') {
      readopted.push(
        ...(await readopt(context, existing.id, name, adapter, now)),
      );
    }

    registered.push({
      id: row!.id,
      name,
      adapter,
      rank: row!.rank,
      health,
      prerequisites,
    });
  }

  return ok({ targets: registered, readopted });
};

/**
 * Re-adopt what a disconnect stranded (§13).
 *
 * The adapter's `observe` is the authority, not core's memory: a workload that
 * kept running while the Target was disconnected is adopted back, and one that
 * is gone stays orphaned rather than being resurrected as live. A Deploy with no
 * `ref` was never placed, so there is nothing to ask about.
 */
async function readopt(
  context: CommandContext,
  targetId: string,
  name: string,
  adapter: TargetAdapter,
  now: Date,
): Promise<string[]> {
  const deployAdapter = context.adapters.deploy(adapter);
  if (deployAdapter === null) return [];

  const stranded = await context.db
    .select()
    .from(deploys)
    .where(
      and(
        eq(deploys.targetId, targetId),
        isNotNull(deploys.orphanedAt),
        isNotNull(deploys.ref),
      ),
    );

  const adopted: string[] = [];
  for (const deploy of stranded) {
    let observed: Awaited<ReturnType<typeof deployAdapter.observe>>;
    try {
      observed = await deployAdapter.observe({ name, adapter }, deploy.ref!);
    } catch {
      // Connect still succeeds. An adapter that cannot answer leaves the
      // Deploy stranded, which is the honest state — not an error to raise.
      continue;
    }
    if (observed === null) continue;

    await context.db
      .update(deploys)
      .set({ orphanedAt: null, phase: observed.phase, updatedAt: now })
      .where(eq(deploys.id, deploy.id));
    adopted.push(String(deploy.id));
  }
  return adopted;
}
