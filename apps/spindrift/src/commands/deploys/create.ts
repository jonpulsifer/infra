/**
 * `createDeploy` — an intent to change what is live at one Component@Target
 * (§2, §6).
 *
 * §6 states the whole mechanism, and it is three rows rather than a protocol:
 *
 * ```
 * Component@Target.desired   one row: which artifact should be live here
 * Build                      a row; its id IS the total order
 * Deploy                     a row; an intent to change `desired`, plus the attempt
 * ```
 *
 * > A **locking read** on the desired row makes two concurrent deploys an atomic
 * > check-and-set. **Rollback is an ordinary deploy** — a newer intent row
 * > pointing at an older Build — so no adapter has a special path. **Cost,
 * > accepted: correctness depends on a transactional store.**
 *
 * Hence the shape below: everything that decides is inside one transaction that
 * opens with `SELECT ... FOR UPDATE` on the desired row. Two concurrent calls for
 * the same pair do not race — the second blocks until the first commits, then
 * reads what the first wrote. That is why this command cannot be tested against
 * a fake database, and why the harness insists on real Postgres.
 *
 * **This command applies nothing.** It writes an intent and returns; the deploy
 * loop (§6: "reconciliation lives in core") is what picks the row up and calls
 * the adapter. Two reasons that split is not bureaucracy: an intent that applied
 * inline would hold the desired row's lock across a call to somebody else's
 * control plane, and a crash mid-apply would lose the intent entirely rather than
 * leaving a row the loop finds again.
 *
 * **It also dispatches no build**, which is §4's "a build records an artifact
 * rather than deploying one" read from the other end. A Deploy names a Build that
 * already succeeded, so there is nothing here to run and — structurally — no
 * `adapters.build` lookup to run it with.
 */
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  builds,
  components,
  componentTargetDesired,
  deploys,
  targets,
} from '../../db/schema.ts';
import { DEFAULT_MINIMUM_BUILD_LEVEL } from '../../domain/build-route.ts';
import { artifactTypeFor, placementTargetOf } from '../../domain/placement.ts';
import { demandSentence, migrationFor } from '../config/migration.ts';
import { type PinnedConfig, readPinnedConfig } from '../config/pinned.ts';
import {
  type Command,
  type CommandContext,
  type CommandFailure,
  type CommandFailureCode,
  type CommandResult,
  failed,
  ok,
} from '../types.ts';

export const createDeployInput = z
  .object({
    componentId: z.uuid(),
    targetId: z.uuid(),
    /** The Build whose artifact should become live here. */
    buildId: z.number().int().positive(),
  })
  .strict();

export type CreateDeployInput = z.infer<typeof createDeployInput>;

export interface CreateDeployResult {
  readonly deployId: number;
  readonly componentId: string;
  readonly targetId: string;
  readonly buildId: number;
  /** Always `PENDING`: the loop owns every phase after this one (§6). */
  readonly phase: 'PENDING';
  /**
   * The Build that was desired here before this intent, if any.
   *
   * Returned because it is what makes this intent legible as a rollback, a
   * roll-forward, or a first deploy — and because the caller read it under the
   * same lock this write took, so it is the one answer that cannot be stale.
   */
  readonly supersededBuildId: number | null;
  /** §10's hash over what this attempt delivers. Never the config itself. */
  readonly configVersion: string;
}

/**
 * Everything that must hold before an intent is worth writing, checked once.
 *
 * Returned as a value rather than thrown so the two commands that share it —
 * this one and `rollback` — refuse identically. A rollback that refused with a
 * different sentence for the same reason would be the "special path" §6 says
 * rollback does not get.
 */
export interface DeployPreconditions {
  readonly componentId: string;
  readonly targetId: string;
  readonly buildId: number;
  readonly reach: 'none' | 'private' | 'public';
  readonly auth: 'none' | 'proxy';
  /**
   * The pinned config document this attempt delivers (§10).
   *
   * Captured here rather than read at apply time, which is what makes a Deploy
   * "exactly Heroku's Release": what a rollback comes back up with is what its
   * Deploy recorded, not what the config items say today.
   */
  readonly config: PinnedConfig;
}

/**
 * What {@link checkDeployable} answers.
 *
 * Its own two-arm type rather than a `CommandResult<DeployPreconditions>`: the
 * success arm carries preconditions, the caller's success arm carries a deploy,
 * and folding both through one generic makes the two indistinguishable to
 * narrowing exactly where it matters.
 */
export type DeployCheck =
  | { readonly ok: true; readonly value: DeployPreconditions }
  | { readonly ok: false; readonly failure: CommandFailure };

/** Refuse a check, in the envelope a command returns unchanged. */
function refuse(code: CommandFailureCode, message: string): DeployCheck {
  return { ok: false, failure: { code, message } };
}

export const createDeploy: Command<
  CreateDeployInput,
  CreateDeployResult
> = async (input, context) => {
  const checked = await checkDeployable(input, context);
  if (!checked.ok) return { ok: false, failure: checked.failure };
  return placeIntent(context, checked.value);
};

/**
 * Write the intent under a locking read on the desired row (§6).
 *
 * The order inside the transaction is the whole correctness argument:
 *
 * 1. **Ensure the desired row exists**, conflict-tolerant. Two first-ever
 *    deploys of the same pair would otherwise both try to insert it and one
 *    would fail on the unique key rather than serializing. With
 *    `ON CONFLICT DO NOTHING` the loser blocks on the index until the winner
 *    commits and then finds the row, which is the serialization we want.
 * 2. **Lock it.** From here to `COMMIT` no other transaction can read this pair's
 *    desired row for update, so what step 3 reads is what step 5 overwrites.
 * 3. **Read what was desired** — under the lock, so it is current.
 * 4. **Insert the Deploy**, which is the intent itself.
 * 5. **Point the desired row at it.** A newer `desiredDeployId` naming an older
 *    `desiredBuildId` is exactly what a rollback is; nothing here needs to know
 *    which of the two happened.
 */
export async function placeIntent(
  context: CommandContext,
  checked: DeployPreconditions,
  /**
   * A veto evaluated **under the lock**, against what is desired right now.
   *
   * Rollback is the caller that needs one: "is this Build older than what is
   * live" is a question about the desired row, and asking it before the lock
   * would let a concurrent deploy change the answer between the read and the
   * write. Returning a sentence refuses; returning `null` proceeds.
   *
   * Allowed to be async because a guard is free to ask the database something
   * before deciding, and because it is the one point inside the transaction a
   * test can hold open — which is what makes the check-and-set falsifiable
   * rather than merely stated (see `test/commands/deploys.test.ts`).
   */
  guard?: (
    desiredBuildId: number | null,
  ) => string | null | Promise<string | null>,
): Promise<CommandResult<CreateDeployResult>> {
  const now = context.clock.now();

  const placed = await context.db.transaction(async (tx) => {
    await tx
      .insert(componentTargetDesired)
      .values({
        componentId: checked.componentId,
        targetId: checked.targetId,
        updatedAt: now,
      })
      .onConflictDoNothing();

    const [desired] = await tx
      .select()
      .from(componentTargetDesired)
      .where(
        and(
          eq(componentTargetDesired.componentId, checked.componentId),
          eq(componentTargetDesired.targetId, checked.targetId),
        ),
      )
      .for('update');

    const supersededBuildId = desired?.desiredBuildId ?? null;

    const vetoed = (await guard?.(supersededBuildId)) ?? null;
    if (vetoed !== null) {
      return { vetoed, deployId: null, supersededBuildId: null };
    }

    const [deploy] = await tx
      .insert(deploys)
      .values({
        componentId: checked.componentId,
        targetId: checked.targetId,
        buildId: checked.buildId,
        phase: 'PENDING',
        // §9: reach and auth are the Component's settings, captured at intent
        // time so a later change to the Component does not retroactively
        // describe what this attempt asked for.
        reach: checked.reach,
        auth: checked.auth,
        // §10, for the same reason and with more at stake: the document is what
        // this Deploy delivers, so a rollback to it delivers that document
        // again rather than whatever config was set in the meantime.
        configVersion: checked.config.version,
        configDocument: checked.config.document,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    await tx
      .update(componentTargetDesired)
      .set({
        desiredBuildId: checked.buildId,
        desiredDeployId: deploy!.id,
        updatedAt: now,
      })
      .where(eq(componentTargetDesired.id, desired!.id));

    return { vetoed: null, deployId: deploy!.id, supersededBuildId };
  });

  if (placed.vetoed !== null) {
    return failed('NOT_DEPLOYABLE', placed.vetoed);
  }

  return ok({
    deployId: placed.deployId,
    componentId: checked.componentId,
    targetId: checked.targetId,
    buildId: checked.buildId,
    phase: 'PENDING' as const,
    supersededBuildId: placed.supersededBuildId,
    configVersion: checked.config.version,
  });
}

/**
 * Everything that is true before a lock is worth taking.
 *
 * Deliberately **outside** the transaction. None of these can change in a way
 * that makes a committed intent wrong — a Build does not un-succeed, a
 * Component's kind does not change — so holding the desired row's lock across
 * them would serialize deploys of *different* pairs behind reads that prove
 * nothing about contention.
 */
export async function checkDeployable(
  input: CreateDeployInput,
  context: CommandContext,
): Promise<DeployCheck> {
  const [component] = await context.db
    .select()
    .from(components)
    .where(eq(components.id, input.componentId));
  if (component === undefined) {
    return refuse(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  const [target] = await context.db
    .select()
    .from(targets)
    .where(eq(targets.id, input.targetId));
  if (target === undefined) {
    return failed('NOT_FOUND', `there is no Target with id ${input.targetId}`);
  }

  const [build] = await context.db
    .select()
    .from(builds)
    .where(eq(builds.id, input.buildId));
  if (build === undefined) {
    return failed('NOT_FOUND', `there is no Build with id ${input.buildId}`);
  }

  if (build.componentId !== component.id) {
    return refuse(
      'NOT_DEPLOYABLE',
      'that Build belongs to a different Component',
    );
  }

  // §13: a disconnected Target strands what is on it and takes nothing new. An
  // intent written against one would sit PENDING forever, because the loop skips
  // disconnected Targets for the same reason the Target loop does.
  if (target.status !== 'connected') {
    return refuse(
      'NOT_DEPLOYABLE',
      `${target.name} is disconnected, so nothing new can be placed on it`,
    );
  }

  // §4: "a build records an artifact rather than deploying one." A Build that has
  // not succeeded has no artifact, so there is nothing for this intent to name —
  // and a Deploy that waited for one would be the fencing token §4 removed.
  if (build.status !== 'SUCCEEDED' || build.artifactDigest === null) {
    return refuse(
      'NOT_DEPLOYABLE',
      `Build ${build.id} has no artifact — it is ${build.status.toLowerCase()}`,
    );
  }

  // §16: policy is read at the moment of every placement, including rollback.
  // A Build is deployable only after core has verified its backend provenance
  // and recorded the signature it created over the admitted artifact.
  if (build.artifactType === 'image') {
    const requiredLevel = target.minBuildLevel ?? DEFAULT_MINIMUM_BUILD_LEVEL;
    if (build.verifiedBuildLevel === null || build.signature === null) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} has no verified provenance and core signature`,
      );
    }
    if (build.verifiedBuildLevel < requiredLevel) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} achieved verified Build Level ${build.verifiedBuildLevel}, and ${target.name} currently requires L${requiredLevel}`,
      );
    }
    // Cryptographically real admission: the recorded signature is re-verified
    // against the recorded artifact digest before any intent row is written.
    // This is the gate both image adapters — Kubernetes and Cloud Run — share,
    // so the real signature format is consumed on both admission paths. A
    // signature that does not verify fails closed; nothing is deployed.
    const admitted = await context.adapters.supplyChain().verifySignature({
      artifactDigest: build.artifactDigest,
      signature: build.signature,
    });
    if (!admitted.ok) {
      return refuse(
        'NOT_DEPLOYABLE',
        `Build ${build.id} signature did not verify` +
          (admitted.reason === null ? '' : `: ${admitted.reason}`),
      );
    }
  }

  // §3: "changing placement across shapes forces a rebuild." The Build's key
  // carries the shape it was built for, so a `files` artifact reaching a Target
  // that runs images is not a deploy that fails later — it is one that never
  // starts, which is the whole reason resolution runs before the build.
  const shape = artifactTypeFor(
    component.kind,
    placementTargetOf(target, {
      artifactTypes:
        context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
      manifest: context.manifest,
    }),
  );
  if (build.targetShape !== shape) {
    return refuse(
      'NOT_DEPLOYABLE',
      `Build ${build.id} produced ${build.targetShape}, and ${target.name} takes ${shape} — this placement needs a rebuild`,
    );
  }

  // §10: "Place names the keys that will not follow and demands them before the
  // move commits." Checked here as well as in `placeComponent`, because a
  // developer who deploys straight at a Target they have not placed on would
  // otherwise get the release §10 exists to prevent: green, running, and
  // missing the variables it was configured with everywhere else.
  const migration = await migrationFor(
    context.db,
    context,
    component.id,
    target.id,
  );
  if (migration.demanded.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      demandSentence(migration.demanded, target.name),
    );
  }

  return {
    ok: true,
    value: {
      componentId: component.id,
      targetId: target.id,
      buildId: build.id,
      reach: component.reach,
      auth: component.auth,
      config: await readPinnedConfig(context.db, component.id, target.id),
    },
  };
}
