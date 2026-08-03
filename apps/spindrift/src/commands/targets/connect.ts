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
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { operatorValuesIssues } from '../../adapters/deploy/kubernetes/values.ts';
import {
  type TargetAdapter,
  targetNameSchema,
} from '../../config/manifest.schema.ts';
import { targets, vessels } from '../../db/schema.ts';
import {
  deriveHealth,
  type PrerequisiteResult,
} from '../../domain/capabilities.ts';
import {
  deployTargetOf,
  surfaceNames,
  type TargetConnection,
  type TargetHealth,
} from '../../domain/target.ts';
import type { VesselKind, VesselLocation } from '../../domain/vessel.ts';
import {
  inspectTarget,
  readoptTargetDeploys,
} from '../../reconciler/target-loop.ts';
import { type Command, failed, ok } from '../types.ts';

/**
 * The delivery flavour a Kubernetes Target declares (§6).
 *
 * Required, with no default: an installation-wide default would be a guess
 * about somebody else's cluster, and §20 puts every such value in the manifest
 * or in the operator's hands rather than in a literal.
 */
const kubernetesDelivery = z.discriminatedUnion('flavour', [
  z
    .object({
      flavour: z.literal('flux-helmrelease'),
      namespace: z.string().trim().min(1),
      /** The `GitRepository` the App chart is fetched from (Milestone 3). */
      sourceRef: z
        .object({
          name: z.string().trim().min(1),
          namespace: z.string().trim().min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      flavour: z.literal('argo-application'),
      namespace: z.string().trim().min(1),
      project: z.string().trim().min(1),
      repoUrl: z.string().trim().min(1),
      revision: z.string().trim().min(1),
      server: z.string().trim().min(1),
    })
    .strict(),
]);

/**
 * §3's asserted half, which an operator states because nothing reports it.
 *
 * Both are optional and both mean "nobody has said": an absent `reaches` falls
 * back to what the adapter serves by construction, and an absent `authReaches`
 * is no authenticated edge. Neither is inferred from the other — a Target can
 * serve a reach it cannot authenticate, which is the whole reason there are two.
 */
const assertions = {
  reaches: z.array(z.enum(['none', 'private', 'public'])).optional(),
  authReaches: z.array(z.enum(['none', 'private', 'public'])).optional(),
};

/** The asserted columns, written only where the operator stated one. */
function assertedBy(input: ConnectTargetInput): {
  reaches?: ('none' | 'private' | 'public')[];
  authReaches?: ('none' | 'private' | 'public')[];
} {
  if (input.kind !== 'cluster') return {};
  return {
    ...(input.reaches === undefined ? {} : { reaches: [...input.reaches] }),
    ...(input.authReaches === undefined
      ? {}
      : { authReaches: [...input.authReaches] }),
  };
}

export const connectTargetInput = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('cluster'),
      /** The vessel's name. Its one surface takes it unchanged. */
      name: targetNameSchema,
      /** §13's prerequisite is OIDC against this, not a credential for it. */
      apiServer: z.url(),
      /** Where an App's workloads land. Never created by Spindrift (§7). */
      namespace: z.string().trim().min(1),
      delivery: kubernetesDelivery,
      /** §33's static reachability input, and §3's stated capabilities. */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
      /** §7's per-Target chart-values field, and what the pin declares. */
      chartValues: z.record(z.string(), z.unknown()).optional(),
      chartContract: z.string().trim().min(1).optional(),
      ...assertions,
    })
    .strict(),
  z
    .object({
      kind: z.literal('gcp-project'),
      /** The vessel's name. Both of its surfaces are derived from it. */
      name: targetNameSchema,
      project: z.string().trim().min(1),
      region: z.string().trim().min(1),
      /**
       * The two control APIs this act registers a Target against — the runtime's
       * and the hosting product's.
       *
       * Two values for one act, which reads like a leak of the split §13 says
       * the operator should not have to think about. It is the opposite: the
       * operator connects one project, and the fact that doing so produces two
       * Targets is precisely why both endpoints are asked for here rather than
       * in two separate connect flows.
       */
      runEndpoint: z.url(),
      hostingEndpoint: z.url(),
      /** Where this project's admission policy is read from (§16). */
      policyEndpoint: z.url().optional(),
      /** §33's static reachability input, and §3's stated capabilities. */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
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

/**
 * The **surface** half of one Target this act registers.
 *
 * Where the boundary is, and what it can reach, are not here — they are the
 * vessel's, stated once by {@link vesselFor}. The operator already supplied
 * `servedHosts` and `reachableRegistries` once per act rather than once per
 * Target, which is the shape this split makes honest: they used to be copied
 * into both connections, where two surfaces of one project could drift apart.
 */
function connectionFor(
  input: ConnectTargetInput,
  adapter: TargetAdapter,
): TargetConnection {
  if (adapter === 'kubernetes') {
    if (input.kind !== 'cluster') {
      throw new Error('a cloud project does not register a cluster Target');
    }
    return {
      adapter,
      namespace: input.namespace,
      delivery: input.delivery,
      ...(input.logHistorySeconds === undefined
        ? {}
        : { logHistorySeconds: input.logHistorySeconds }),
      ...(input.chartValues === undefined
        ? {}
        : { chartValues: input.chartValues }),
      ...(input.chartContract === undefined
        ? {}
        : { chartContract: input.chartContract }),
    };
  }
  if (input.kind !== 'gcp-project') {
    throw new Error('a cluster does not register a cloud Target');
  }
  if (adapter === 'cloudrun') {
    return {
      adapter,
      region: input.region,
      endpoint: input.runEndpoint,
      ...(input.policyEndpoint === undefined
        ? {}
        : { policyEndpoint: input.policyEndpoint }),
      // Only this surface has a runtime to have produced output; static
      // hosting gets §17's honest empty state rather than a duration.
      ...(input.logHistorySeconds === undefined
        ? {}
        : { logHistorySeconds: input.logHistorySeconds }),
    };
  }
  return { adapter, endpoint: input.hostingEndpoint };
}

/** The boundary this act connects, as a row to create or update. */
function vesselFor(input: ConnectTargetInput): {
  kind: VesselKind;
  location: VesselLocation;
  servedHosts: string[] | null;
  reachableRegistries: string[] | null;
} {
  return {
    kind: input.kind,
    location:
      input.kind === 'cluster'
        ? { kind: 'cluster', apiServer: input.apiServer }
        : { kind: 'gcp-project', project: input.project },
    servedHosts:
      input.servedHosts === undefined ? null : [...input.servedHosts],
    reachableRegistries:
      input.reachableRegistries === undefined
        ? null
        : [...input.reachableRegistries],
  };
}

export const connectTarget: Command<
  ConnectTargetInput,
  ConnectTargetResult
> = async (input, context) => {
  // §7: the boundary between the value classes is "enforced at save time".
  // This is that time — the operator who typed these is still here to be told
  // which key was not theirs, which is not true of the deploy that would
  // otherwise discover it.
  if (input.kind === 'cluster') {
    const issues = operatorValuesIssues(input.chartValues);
    if (issues.length > 0) {
      return failed(
        'INVALID_INPUT',
        'these chart values are not an operator’s to set',
        issues.map((issue) => ({
          path: `chartValues.${issue.path}`,
          message: issue.message,
        })),
      );
    }
  }

  const now = context.clock.now();
  const registered: ConnectedTarget[] = [];
  const readopted: string[] = [];

  // The boundary first, because every surface below is a row that references
  // it. Idempotent by name for the same reason connect is: reconnecting a
  // project must reuse its vessel rather than mint a second one that its two
  // surfaces would then be split across.
  const desiredVessel = vesselFor(input);
  const existingVessel = (
    await context.db.select().from(vessels).where(eq(vessels.name, input.name))
  )[0];
  const vessel =
    existingVessel === undefined
      ? (
          await context.db
            .insert(vessels)
            .values({
              name: input.name,
              ...desiredVessel,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        )[0]!
      : (
          await context.db
            .update(vessels)
            .set({ ...desiredVessel, updatedAt: now })
            .where(eq(vessels.id, existingVessel.id))
            .returning()
        )[0]!;

  for (const { name, adapter } of surfaceNames(input.kind, input.name)) {
    const existing = (
      await context.db.select().from(targets).where(eq(targets.name, name))
    )[0];

    const connection = connectionFor(input, adapter);
    // The flat view the adapter takes, composed from the surface just built and
    // the boundary above it — the same composition the loops perform.
    const ref = deployTargetOf(
      { name, adapter, connection },
      // Built from what was just written rather than re-read: `vesselFor`
      // always states a location, which the nullable column cannot know.
      { ...desiredVessel, location: desiredVessel.location },
    );
    // One pass of the same loop §13 runs on a schedule — not a second notion of
    // what "healthy" means that happens to run at connect time.
    const { prerequisites, discovery } = await inspectTarget(context, ref);
    const health = deriveHealth(prerequisites, adapter);

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
          vesselId: vessel.id,
          connection,
          health,
          prerequisites,
          discovery,
          inspectedAt: now,
          rank: next,
          createdAt: now,
          updatedAt: now,
          ...assertedBy(input),
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
        // A reconnect may move a surface onto a different vessel — connecting
        // the same name against another project is a correction, not a second
        // Target.
        vesselId: vessel.id,
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
        ...(await readoptTargetDeploys(context, existing.id, ref, now)),
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
