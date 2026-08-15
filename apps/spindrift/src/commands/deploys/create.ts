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
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  builds,
  components,
  componentTargetDesired,
  datastores,
  deploys,
} from '../../db/schema.ts';
import { DEFAULT_MINIMUM_BUILD_LEVEL } from '../../domain/build-route.ts';
import {
  DATASTORE_VARIABLE,
  type DesiredDocument,
} from '../../domain/desired-state.ts';
import {
  artifactTypeFor,
  DEFAULT_PLATFORM,
  placementTargetOf,
  reachExclusions,
  sentence,
  takesShape,
} from '../../domain/placement.ts';
import { targetRowLabel } from '../../domain/target.ts';
import { demandSentence, migrationFor } from '../config/migration.ts';
import { type PinnedConfig, readPinnedConfig } from '../config/pinned.ts';
import { storeOfRecordOf } from '../config/set.ts';
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
  /**
   * Everything this attempt places, captured here rather than read at apply
   * time — which is what makes a Deploy "exactly Heroku's Release": what a
   * rollback comes back up with is what its Deploy recorded, not what the
   * Component and config rows say today.
   *
   * §10 made this argument for the config document alone. It was never specific
   * to config: a Component's kind, exposure and schedule are read by the same
   * apply, and re-reading them gives a rollback yesterday's artifact under
   * today's shape.
   */
  readonly desired: DesiredDocument;
  /** §10's hash over `desired.config`, materialized because the UI lists it. */
  readonly configVersion: string;
}

/**
 * The same preconditions, delivering a different config document.
 *
 * One caller replaces exactly this leg and nothing else: a config change
 * deploys what was *just written* rather than what `checkDeployable` read a
 * moment earlier. It leaves the rest of the shape alone, because setting a
 * variable is not a request to undo unrelated edits.
 *
 * A rollback wants more than this and uses {@link deliveringRelease}, which is
 * built on it.
 *
 * A function rather than the spread written twice, because the spread is
 * nested: `{ ...value, config: pinned }` type-checks against nothing and
 * silently pins the old document, which is the bug this whole column exists to
 * remove.
 */
export function deliveringConfig(
  value: DeployPreconditions,
  config: PinnedConfig,
): DeployPreconditions {
  return {
    ...value,
    configVersion: config.version,
    desired: { ...value.desired, config: config.document },
  };
}

/**
 * The same preconditions, delivering the release a rollback is going back to.
 *
 * {@link DesiredDocument} states the rule this implements and the argument for
 * it: a rollback restores how yesterday's artifact **ran** — its entrypoint,
 * its arguments, its schedule, its config — and never where it **answered**.
 * `expose`, `reach` and `auth` stay as the Component has them today, because
 * they are the `hostname` exclusion one layer down, and `datastores` stays
 * because attaching and detaching are deliberate acts this must not undo.
 *
 * Each replayed field is spread conditionally rather than assigned, because
 * they are optional: writing `schedule: previous.schedule` onto a document
 * whose previous release had none would set the key to `undefined` rather than
 * leave it absent, and an unscheduled job is the absence.
 */
export function deliveringRelease(
  value: DeployPreconditions,
  previous: {
    readonly desired: DesiredDocument;
    readonly configVersion: string;
  },
): DeployPreconditions {
  const was = previous.desired;
  return {
    ...value,
    configVersion: previous.configVersion,
    desired: {
      ...value.desired,
      config: was.config,
      ...(was.schedule === undefined ? {} : { schedule: was.schedule }),
      ...(was.command === undefined ? {} : { command: was.command }),
      ...(was.args === undefined ? {} : { args: was.args }),
    },
  };
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

/**
 * The Datastores a refusal is about, named the way their owner named them.
 *
 * Every one that is wrong, not the first: a developer who fixes the one the
 * message named and is refused again for the next has been told a fact rather
 * than the problem.
 */
function names(rows: readonly { readonly name: string }[]): string {
  return rows.map((row) => row.name).join(', ');
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
/**
 * Which of this document's pinned config references no longer resolve, as one
 * sentence — or `null` when every one of them still does.
 *
 * §10 pins a config version so that "a rollback comes back up with the
 * configuration it originally had", and the store contract names the verb that
 * makes the promise checkable: `describe` is "the read-back… core uses it to
 * prove a Deploy's pinned document still resolves before it deploys against
 * it." Nothing called it. So the guarantee held for as long as nothing had
 * reaped a version, and the moment something had — §10's own N = 10 retention
 * does exactly that on a loop — a rollback past it deployed **green and
 * unconfigured**, which is the failure §10 names retention depth to avoid.
 *
 * Checked here rather than in either caller because both reach it: an ordinary
 * deploy delivers config as it is now, a rollback delivers the document the
 * older release carried, and it is the second one whose pins have had time to
 * go. Before the transaction, not inside it — this asks a far side, and a
 * network call holding a row lock is a different bug.
 *
 * **Fails closed, and says which keys.** A developer told "some config is
 * missing" has been told a fact rather than the problem; the keys are what they
 * act on, and re-setting any one of them mints a new version and a new Deploy.
 */
async function unresolvedPins(
  context: CommandContext,
  checked: DeployPreconditions,
): Promise<string | null> {
  const config = checked.desired.config;
  if (config.length === 0) return null;

  // With the boundary, for the same reason `checkDeployable` reads it that way:
  // half of what names a Target in a refusal lives there.
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, checked.targetId),
    with: { vessel: true },
  });
  if (target === undefined) return null;

  const adapter = storeOfRecordOf(context, target);
  // No store of record is not an unresolved pin: it is a Target that cannot
  // hold config at all, and a document on one is core's bug rather than a
  // reaped version. `checkDeployable` is where that is refused.
  if (adapter === null) return null;
  const store = context.adapters.store(adapter);
  if (store === null) return null;

  const gone: string[] = [];
  for (const entry of config) {
    // One at a time and in order, so the sentence lists keys the way the
    // document does. A store that refuses the read is not a version that is
    // gone — it is a store that cannot answer — and turning an outage into
    // "your config was deleted" would send somebody looking for the wrong
    // thing, so it propagates rather than being folded in here.
    if ((await store.describe(entry.secret)) === null) gone.push(entry.name);
  }
  if (gone.length === 0) return null;

  return (
    `this release is pinned to config versions that no longer exist in ${targetRowLabel(target)}: ` +
    `${gone.join(', ')}. Deploying it would bring the Component up without them, so it is refused — ` +
    'set each one again to mint a new version, which deploys as an ordinary change.'
  );
}

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
  const unresolved = await unresolvedPins(context, checked);
  if (unresolved !== null) return failed('NOT_DEPLOYABLE', unresolved);

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

    // A first intent for a Component with no placement of record establishes
    // one — that is what "a first deploy writes it" means. Conditional on NULL
    // so an intent addressed at a retired pair (rollback, config-set) never
    // moves a placed Component: only `placeComponent` does that.
    await tx
      .update(components)
      .set({ placedTargetId: checked.targetId })
      .where(
        and(
          eq(components.id, checked.componentId),
          isNull(components.placedTargetId),
        ),
      );

    const [deploy] = await tx
      .insert(deploys)
      .values({
        componentId: checked.componentId,
        targetId: checked.targetId,
        buildId: checked.buildId,
        phase: 'PENDING',
        // The document this Deploy places, captured at intent time so that a
        // later edit to the Component does not retroactively describe what this
        // attempt asked for, and so a rollback to it places what it placed.
        desired: checked.desired,
        configVersion: checked.configVersion,
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
    configVersion: checked.configVersion,
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

  const [app] = await context.db
    .select()
    .from(apps)
    .where(eq(apps.id, component.appId));
  if (app === undefined) {
    // Unreachable while the foreign key holds, which is what makes this a
    // refusal rather than a `!`: a Component whose App has been deleted is not
    // a state to compose a release document out of.
    return refuse('NOT_FOUND', `Component ${component.name} has no App`);
  }

  // With the boundary, because half of what names a Target lives there.
  const target = await context.db.query.targets.findFirst({
    where: (targets, { eq }) => eq(targets.id, input.targetId),
    with: { vessel: true },
  });
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
      `${targetRowLabel(target)} is disconnected, so nothing new can be placed on it`,
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
        `Build ${build.id} achieved verified Build Level ${build.verifiedBuildLevel}, and ${targetRowLabel(target)} currently requires L${requiredLevel}`,
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

  // §3: a Build's key carries the shape it was built for, so a shape this
  // Target's adapter has no rendering of is not a deploy that fails later — it
  // is one that never starts, which is the whole reason resolution runs before
  // the build. Membership in the adapter's accept list, not equality with the
  // one shape a fresh build here would take: Vercel prefers `vercel-output`
  // and still serves plain `files`, so a static site moving in from Pages or
  // Firebase ships the artifact it already has (`takesShape`).
  const placement = placementTargetOf(target, {
    artifactTypes:
      context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
    manifest: context.manifest,
  });
  if (!takesShape(component.kind, build.targetShape, placement)) {
    const shape = artifactTypeFor(component.kind, placement);
    return refuse(
      'NOT_DEPLOYABLE',
      `Build ${build.id} produced ${build.targetShape}, and ${targetRowLabel(target)} takes ${shape} — this placement needs a rebuild`,
    );
  }

  // §3's asserted half, asked where it binds. Placement filtered on it when the
  // developer was *offered* this Target, and nothing re-asked when the Deploy
  // was created — so a Component could be released at a reach its Target
  // declares it does not serve, which makes that declaration advisory. It is a
  // boundary: a Target that says it has no public address is stating something
  // about the network it is on, not a preference.
  //
  // Reach and auth only. The rest of `exclusionsFor` belongs to the screen that
  // offers a placement, not to the act of releasing one — refusing an UNHEALTHY
  // Target here would block the rollback `./rollback.ts` exists to keep possible
  // while the Target is unhealthy.
  const unserved = reachExclusions(placement.capabilities, component);
  if (unserved.length > 0) {
    const why = unserved
      .map((reason) =>
        sentence(reason, {
          kind: component.kind,
          reach: component.reach,
          platform: DEFAULT_PLATFORM,
        }),
      )
      .join('; ');
    return refuse(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} does not serve this Component's ${component.reach} reach — ${why}`,
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
      demandSentence(migration.demanded, targetRowLabel(target)),
    );
  }

  const config = await readPinnedConfig(context.db, component.id, target.id);

  // §11: "Delivery follows the Datastore's placement." Attached at the App, so
  // every Component of the App is released with the same set — which is what
  // makes the two refusals below properties of the release rather than of one
  // Component.
  const attached = await context.db
    .select({
      name: datastores.name,
      engine: datastores.engine,
      connectionRef: datastores.connectionRef,
      vesselId: datastores.vesselId,
    })
    .from(datastores)
    .where(eq(datastores.appId, app.id));

  // An in-cluster Datastore is cluster-local, and the credential is delivered
  // as a `secretKeyRef` at the operator's own Secret — a reference that cannot
  // leave the namespace it is rendered in, let alone the cluster. Released
  // anyway, the pod sits in `CreateContainerConfigError` and the Deploy reports
  // a timeout rather than the cause. The comparison is boundary to boundary:
  // the Datastore lives in a vessel, and a release onto any surface of that
  // same vessel can reach it.
  //
  // `checkDeployable` runs `reachExclusions` only, deliberately (above), so
  // `placement.ts`'s `DATASTORE_IS_CLUSTER_LOCAL` — the same fact, asked where a
  // Target is *offered* — does not cover this path. Asked again here for the
  // reason the reach gate is: a boundary enforced only where a placement is
  // offered is advisory.
  const elsewhere = attached.filter((row) => row.vesselId !== target.vesselId);
  if (elsewhere.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      `${targetRowLabel(target)} cannot reach ${names(elsewhere)} — a Datastore is delivered only into the vessel it lives in`,
    );
  }

  // Still provisioning: the operator has not generated the credential yet, so
  // there is no reference to render. This is the config demand rule above read
  // for datastores — a release that comes up green with no `DATABASE_URL` is
  // precisely what refusing before the intent exists to prevent.
  const unprovisioned = attached.filter((row) => row.connectionRef === null);
  if (unprovisioned.length > 0) {
    return refuse(
      'NOT_DEPLOYABLE',
      `${names(unprovisioned)} ${unprovisioned.length === 1 ? 'is' : 'are'} still provisioning and ${unprovisioned.length === 1 ? 'has' : 'have'} no connection to deliver yet`,
    );
  }

  return {
    ok: true,
    value: {
      componentId: component.id,
      targetId: target.id,
      buildId: build.id,
      configVersion: config.version,
      desired: {
        app: app.name,
        component: component.name,
        target: targetRowLabel(target),
        kind: component.kind,
        // Optional on `DesiredState`, so absent rather than null — the chart
        // branches on emptiness and the adapters spread this straight through.
        ...(component.expose === null ? {} : { expose: component.expose }),
        reach: component.reach,
        auth: component.auth,
        ...(component.schedule === null
          ? {}
          : { schedule: component.schedule }),
        // The entrypoint this release runs, pinned for the same reason as
        // everything else here: null on the row is the image's own, and an
        // edit after this intent was written must not change what this intent
        // placed. Two Components off one image differ here and nowhere else.
        ...(component.command === null ? {} : { command: component.command }),
        ...(component.args === null ? {} : { args: component.args }),
        config: config.document,
        // Optional, so absent rather than an empty array: an App with nothing
        // attached pins the document it always pinned, and a `desired` written
        // before datastores existed reads back identically to one written now.
        ...(attached.length === 0
          ? {}
          : {
              datastores: attached.map((row) => ({
                // Resolved here, once, and pinned resolved — exactly as §10
                // pins resolved config variable names. Nothing downstream ever
                // sees the engine.
                name: DATASTORE_VARIABLE[row.engine],
                connection: row.connectionRef as string,
              })),
            }),
        // §3 keeps core out of scheduling and detection has not landed, so
        // nothing states a platform or a size yet. Pinned as the constant it
        // has always been applied as, so that the day something does state one
        // this is the only place that changes.
        requirements: { platform: DEFAULT_PLATFORM, resources: {} },
      },
    },
  };
}
