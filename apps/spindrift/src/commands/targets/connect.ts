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
 * project asks about *both* of that project's surfaces — `cloudrun` and
 * `static` — because placement determines artifact shape and a single "Cloud"
 * Target would leave a website ambiguous between the two renderings. That is
 * also why no `Provider` noun exists: the shared thing is an argument to this
 * command.
 *
 * **What it asks about and what it registers are different lists.**
 * `surfacesToProbe` names the questions; the Targets are the answers. A project
 * whose Cloud Run API is switched off gets no `cloudrun` Target — it gets a
 * checklist saying the surface is not there, and connect still succeeds. A
 * surface the probe could not settle *does* get its Target, unhealthy, with the
 * sentence attached: withholding a row on a refused read would state an absence
 * nobody established. Neither arm ever removes a Target that already exists —
 * a row that has been deployed to is not a probe's to delete.
 *
 * Connect is **idempotent by `(vessel, adapter)`** — which is what a Target is,
 * so there is nothing else it could be idempotent by. Re-running it re-inspects,
 * keeps each Target's id and rank, and — if it had been disconnected — re-adopts
 * what it stranded, by asking the adapter to `observe` each orphaned Deploy
 * (§13: "reconnect re-adopts via `observe`").
 */
import { and, eq, sql } from 'drizzle-orm';
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
  type TargetConnection,
  type TargetHealth,
} from '../../domain/target.ts';
import {
  surfacesToProbe,
  type VesselKind,
  type VesselLocation,
} from '../../domain/vessel.ts';
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
      /** The Flux source object the App chart is fetched from (§7). */
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
      /** The boundary being connected, by name. Every surface on it is registered. */
      vessel: targetNameSchema,
      /** §13's prerequisite is OIDC against this, not a credential for it. */
      apiServer: z.url(),
      /** Where an App's workloads land. Never created by Spindrift (§7). */
      namespace: z.string().trim().min(1),
      delivery: kubernetesDelivery,
      /** §33's static reachability input, and §3's stated capabilities. */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
      /** §7's per-Target chart-values field. */
      chartValues: z.record(z.string(), z.unknown()).optional(),
      ...assertions,
    })
    .strict(),
  z
    .object({
      kind: z.literal('gcp-project'),
      /** The boundary being connected, by name. Both of its surfaces are registered. */
      vessel: targetNameSchema,
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
      /**
       * The identity a revision runs as, and the one a schedule fires as (§7).
       *
       * Accepted here because the declared form already carries it
       * (`config/manifest.schema.ts`) and the two shapes must not disagree about
       * what a Cloud Run connection is. It decides a capability rather than only
       * a runtime detail: a Cloud Scheduler job authenticates the `jobs.run`
       * call it makes, so a Target naming none is a `NO_SCHEDULER`
       * non-candidate for a scheduled job — see `firesSchedulesOn` in
       * `domain/capabilities.ts`. Optional, because a project used only for
       * services needs no identity of its own.
       */
      serviceAccount: z.string().trim().min(1).optional(),
      /** §33's static reachability input, and §3's stated capabilities. */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('vercel-team'),
      /** The boundary being connected, by name. Its one surface is `vercel`. */
      vessel: targetNameSchema,
      /** The team or account slug, or its `team_…` id. Both address the API. */
      team: z.string().trim().min(1),
      /** The platform's API root. Asked for rather than assumed (§20). */
      endpoint: z.url(),
      /**
       * §33's static reachability input.
       *
       * No `reachableRegistries`: nothing here pulls an image — the deploy
       * uploads the bytes — and no `logHistorySeconds`, because there is no
       * runtime whose output a tail could reach back into.
       */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cloudflare-account'),
      /** The boundary being connected, by name. Its one surface is registered. */
      vessel: targetNameSchema,
      /** The account id every project on this boundary is created under. */
      account: z.string().trim().min(1),
      /** The platform's API root. Asked for rather than assumed (§20). */
      pagesEndpoint: z.url(),
      /** §33's static reachability input, on the same terms as above. */
      servedHosts: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
]);

export type ConnectTargetInput = z.infer<typeof connectTargetInput>;

/** One registered Target, as the operator's confirmation shows it. */
export interface ConnectedTarget {
  readonly id: string;
  /** The boundary it is a surface on — the two together are what name it. */
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  readonly rank: number;
  readonly health: TargetHealth;
  /** Every checklist item, met or not — §3's grammar of stated reasons. */
  readonly prerequisites: readonly PrerequisiteResult[];
}

/** A surface this act probed for and established the vessel does not carry. */
export interface AbsentSurface {
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  /**
   * The checklist as the probe answered it.
   *
   * Every row unmet, and the one that establishes the absence carries the
   * sentence — the same grammar a registered Target's unmet item has, because
   * "there is no Cloud Run here" and "Cloud Run here is unhealthy" are the same
   * kind of thing to read and act on.
   */
  readonly prerequisites: readonly PrerequisiteResult[];
  /** What the probe established, in one sentence. */
  readonly detail: string;
}

export interface ConnectTargetResult {
  /** One entry per surface the probe did not rule out (§13). */
  readonly targets: readonly ConnectedTarget[];
  /**
   * Surfaces the probe established are not on this vessel, and so were not
   * registered. Empty is the ordinary case; a non-empty entry is why a project
   * an operator expected two Targets from produced one.
   */
  readonly absent: readonly AbsentSurface[];
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
    };
  }
  if (adapter === 'vercel') {
    if (input.kind !== 'vercel-team') {
      throw new Error('only a Vercel team registers a Vercel Target');
    }
    return { adapter, endpoint: input.endpoint };
  }
  if (adapter === 'cloudflare-pages') {
    if (input.kind !== 'cloudflare-account') {
      throw new Error('only a Cloudflare account registers a Pages Target');
    }
    return { adapter, endpoint: input.pagesEndpoint };
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
      // Only this surface runs anything, so only this one has an identity to
      // run it as — static hosting serves files and authenticates nothing.
      ...(input.serviceAccount === undefined
        ? {}
        : { serviceAccount: input.serviceAccount }),
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
    location: locationOf(input),
    servedHosts:
      input.servedHosts === undefined ? null : [...input.servedHosts],
    // Neither edge boundary states one: nothing on either pulls an image, so
    // the field is absent from both arms rather than stated empty.
    reachableRegistries:
      input.kind === 'vercel-team' ||
      input.kind === 'cloudflare-account' ||
      input.reachableRegistries === undefined
        ? null
        : [...input.reachableRegistries],
  };
}

/** Where the boundary is, in the terms its own kind states it in. */
function locationOf(input: ConnectTargetInput): VesselLocation {
  switch (input.kind) {
    case 'cluster':
      return { kind: 'cluster', apiServer: input.apiServer };
    case 'gcp-project':
      return { kind: 'gcp-project', project: input.project };
    case 'vercel-team':
      return { kind: 'vercel-team', team: input.team };
    case 'cloudflare-account':
      return { kind: 'cloudflare-account', account: input.account };
  }
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
  const absent: AbsentSurface[] = [];
  const readopted: string[] = [];

  // The boundary first, because every surface below is a row that references
  // it. Idempotent by name for the same reason connect is: reconnecting a
  // project must reuse its vessel rather than mint a second one that its two
  // surfaces would then be split across.
  const desiredVessel = vesselFor(input);
  const existingVessel = (
    await context.db
      .select()
      .from(vessels)
      .where(eq(vessels.name, input.vessel))
  )[0];
  const vessel =
    existingVessel === undefined
      ? (
          await context.db
            .insert(vessels)
            .values({
              name: input.vessel,
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

  // Idempotent by `(vessel, adapter)`, which is what a Target *is*: reconnecting
  // re-adopts the surface that is already there rather than registering a second
  // one competing for the same workloads.
  for (const adapter of surfacesToProbe(input.kind)) {
    const existing = (
      await context.db
        .select()
        .from(targets)
        .where(
          and(eq(targets.vesselId, vessel.id), eq(targets.adapter, adapter)),
        )
    )[0];

    const connection = connectionFor(input, adapter);
    // The flat view the adapter takes, composed from the surface just built and
    // the boundary above it — the same composition the loops perform.
    const ref = deployTargetOf(
      { adapter, connection },
      // Built from what was just written rather than re-read: `vesselFor`
      // always states a location, which the nullable column cannot know.
      {
        ...desiredVessel,
        name: input.vessel,
        location: desiredVessel.location,
      },
    );
    // One pass of the same loop §13 runs on a schedule — not a second notion of
    // what "healthy" means that happens to run at connect time.
    const { prerequisites, discovery, surface } = await inspectTarget(
      context,
      ref,
    );
    const health = deriveHealth(prerequisites, adapter);

    if (surface.kind === 'absent' && existing === undefined) {
      // The only branch that writes nothing. An established absence is a fact
      // about this boundary, so registering the surface anyway would put a row
      // on the placement screen that nothing can ever be placed on — and
      // §14 forbids the one remediation that would make it true, which is
      // Spindrift switching the service on.
      absent.push({
        vessel: input.vessel,
        adapter,
        prerequisites,
        detail: surface.detail,
      });
      continue;
    }

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
        vessel: input.vessel,
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
        // The same assertion the INSERT branch takes. Without it a reconnect
        // dropped what the operator had just stated on the connect screen —
        // which derives both from the gateway address and the tunnel — so §3's
        // asserted half could only ever be set by a Target's very first write.
        ...assertedBy(input),
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
      vessel: input.vessel,
      adapter,
      rank: row!.rank,
      health,
      prerequisites,
    });
  }

  return ok({ targets: registered, absent, readopted });
};
