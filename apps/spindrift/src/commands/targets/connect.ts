/**
 * `connectTarget`: probe every surface on a vessel and register each one the
 * probe does not rule out. Reachability never blocks it; an unreachable surface
 * becomes an unhealthy Target with its checklist. Idempotent by vessel and
 * adapter, and reconnecting re-adopts orphaned Deploys.
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
import { readVesselDiscovery } from '../../reconciler/vessel-loop.ts';
import { type Command, failed, ok } from '../types.ts';

/** Required, because any default would guess at somebody else's cluster. */
const kubernetesDelivery = z.discriminatedUnion('flavour', [
  z
    .object({
      flavour: z.literal('flux-helmrelease'),
      namespace: z.string().trim().min(1),
      /** The Flux source the App chart is fetched from. */
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
 * Reach an operator states because nothing reports it. Absent means the
 * adapter's default.
 */
const assertions = {
  reaches: z.array(z.enum(['none', 'private', 'public'])).optional(),
  authReaches: z.array(z.enum(['none', 'private', 'public'])).optional(),
};

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
      vessel: targetNameSchema,
      /** Reached through OIDC trust, so the operator supplies no credential. */
      apiServer: z.url(),
      /** Where App workloads land. It must already exist. */
      namespace: z.string().trim().min(1),
      delivery: kubernetesDelivery,
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
      chartValues: z.record(z.string(), z.unknown()).optional(),
      ...assertions,
    })
    .strict(),
  z
    .object({
      kind: z.literal('gcp-project'),
      vessel: targetNameSchema,
      project: z.string().trim().min(1),
      region: z.string().trim().min(1),
      /** Absent: each adapter's default. Set behind a perimeter or mirror. */
      runEndpoint: z.url().optional(),
      hostingEndpoint: z.url().optional(),
      /** Where this project's admission policy is read from. */
      policyEndpoint: z.url().optional(),
      /**
       * The identity a revision runs as and a schedule fires as. Without it the
       * Target cannot run a scheduled job (`NO_SCHEDULER`).
       */
      serviceAccount: z.string().trim().min(1).optional(),
      servedHosts: z.array(z.string().trim().min(1)).optional(),
      reachableRegistries: z.array(z.string().trim().min(1)).optional(),
      logHistorySeconds: z.number().int().nonnegative().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('vercel-team'),
      vessel: targetNameSchema,
      /** A team or account slug, or its `team_…` id. */
      team: z.string().trim().min(1),
      /** Absent: the adapter's default. Set behind a perimeter or mirror. */
      endpoint: z.url().optional(),
      servedHosts: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cloudflare-account'),
      vessel: targetNameSchema,
      /** The account id projects are created under. */
      account: z.string().trim().min(1),
      /**
       * The account's API root, shared by Pages, Workers and the zone listing.
       * Absent: the adapter's default. Set behind a perimeter or mirror.
       */
      endpoint: z.url().optional(),
      servedHosts: z.array(z.string().trim().min(1)).optional(),
    })
    .strict(),
]);

export type ConnectTargetInput = z.infer<typeof connectTargetInput>;

export interface ConnectedTarget {
  readonly id: string;
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  readonly rank: number;
  readonly health: TargetHealth;
  /** Every checklist item, met or not. */
  readonly prerequisites: readonly PrerequisiteResult[];
}

/** A surface the probe established the vessel does not carry. */
export interface AbsentSurface {
  readonly vessel: string;
  readonly adapter: TargetAdapter;
  readonly prerequisites: readonly PrerequisiteResult[];
  readonly detail: string;
}

export interface ConnectTargetResult {
  /** One entry per surface the probe did not rule out. */
  readonly targets: readonly ConnectedTarget[];
  readonly absent: readonly AbsentSurface[];
  /** Deploys a previous disconnect orphaned that are still running. */
  readonly readopted: readonly string[];
}

/**
 * The surface half of a Target. Location and reach are the vessel's, set in
 * {@link vesselFor}.
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
    return {
      adapter,
      // An absent key means the adapter's default endpoint.
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    };
  }
  if (adapter === 'cloudflare-pages') {
    if (input.kind !== 'cloudflare-account') {
      throw new Error('only a Cloudflare account registers a Pages Target');
    }
    return {
      adapter,
      ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
    };
  }
  if (input.kind !== 'gcp-project') {
    throw new Error('a cluster does not register a cloud Target');
  }
  if (adapter === 'cloudrun') {
    return {
      adapter,
      region: input.region,
      ...(input.runEndpoint === undefined
        ? {}
        : { endpoint: input.runEndpoint }),
      ...(input.policyEndpoint === undefined
        ? {}
        : { policyEndpoint: input.policyEndpoint }),
      // Static hosting runs nothing, so only this surface takes an identity
      // and log history.
      ...(input.serviceAccount === undefined
        ? {}
        : { serviceAccount: input.serviceAccount }),
      ...(input.logHistorySeconds === undefined
        ? {}
        : { logHistorySeconds: input.logHistorySeconds }),
    };
  }
  return {
    adapter,
    ...(input.hostingEndpoint === undefined
      ? {}
      : { endpoint: input.hostingEndpoint }),
  };
}

function vesselFor(
  input: ConnectTargetInput,
  existingLocation: VesselLocation | null,
): {
  kind: VesselKind;
  location: VesselLocation;
  servedHosts: string[] | null;
  reachableRegistries: string[] | null;
} {
  return {
    kind: input.kind,
    location: locationOf(input, existingLocation),
    servedHosts:
      input.servedHosts === undefined ? null : [...input.servedHosts],
    // Edge vessels pull no image, so their inputs carry no registries.
    reachableRegistries:
      input.kind === 'vercel-team' ||
      input.kind === 'cloudflare-account' ||
      input.reachableRegistries === undefined
        ? null
        : [...input.reachableRegistries],
  };
}

function locationOf(
  input: ConnectTargetInput,
  existing: VesselLocation | null,
): VesselLocation {
  switch (input.kind) {
    case 'cluster':
      return { kind: 'cluster', apiServer: input.apiServer };
    case 'gcp-project':
      // Keep the manifest-seeded network, which connect never asks for.
      return {
        kind: 'gcp-project',
        project: input.project,
        ...(existing?.kind === 'gcp-project' && existing.network !== undefined
          ? { network: existing.network }
          : {}),
      };
    case 'vercel-team':
      return { kind: 'vercel-team', team: input.team };
    case 'cloudflare-account':
      return {
        kind: 'cloudflare-account',
        account: input.account,
        ...(input.endpoint === undefined ? {} : { endpoint: input.endpoint }),
      };
  }
}

export const connectTarget: Command<
  ConnectTargetInput,
  ConnectTargetResult
> = async (input, context) => {
  // The probe below authenticates to the endpoints in the input with the
  // installation's own credentials, so a bearer credential must not pick them.
  if (context.principal.kind !== 'human') {
    return failed(
      'FORBIDDEN',
      'an agent token cannot connect a Target — sign in and connect it from Targets',
    );
  }

  // Check chart values at save time, while the operator can still fix them.
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

  // The vessel first, since each Target row references it. Reuse by name so a
  // reconnect keeps one vessel.
  const existingVessel = (
    await context.db
      .select()
      .from(vessels)
      .where(eq(vessels.name, input.vessel))
  )[0];
  const desiredVessel = vesselFor(input, existingVessel?.location ?? null);
  // Read now so the next screen can list the vessel's contents. `null` for a
  // kind with no account-wide listing.
  const discovery = await readVesselDiscovery(context.adapters, {
    name: input.vessel,
    kind: desiredVessel.kind,
    location: desiredVessel.location,
  });
  const vessel =
    existingVessel === undefined
      ? (
          await context.db
            .insert(vessels)
            .values({
              name: input.vessel,
              ...desiredVessel,
              discovery,
              createdAt: now,
              updatedAt: now,
            })
            .returning()
        )[0]!
      : (
          await context.db
            .update(vessels)
            .set({ ...desiredVessel, discovery, updatedAt: now })
            .where(eq(vessels.id, existingVessel.id))
            .returning()
        )[0]!;

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
    const ref = deployTargetOf(
      { adapter, connection },
      // `desiredVessel` always has a location; the stored column is nullable.
      {
        ...desiredVessel,
        name: input.vessel,
        location: desiredVessel.location,
      },
    );
    const { prerequisites, discovery, surface } = await inspectTarget(
      context,
      ref,
    );
    const health = deriveHealth(prerequisites, adapter);

    if (surface.kind === 'absent' && existing === undefined) {
      // Nothing could be placed on an established absence, so it gets no Target.
      // An existing Target stays: the probe does not delete a deployed-to row.
      absent.push({
        vessel: input.vessel,
        adapter,
        prerequisites,
        detail: surface.detail,
      });
      continue;
    }

    if (existing === undefined) {
      // A new Target joins the end of the global rank.
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
