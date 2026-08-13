/**
 * `resolveComponentPlacement` — where can this Component go, and where can it
 * not (§3).
 *
 * The command is thin because §3 makes it thin. All it does is *derive* the
 * requirements — from the Component's kind, its exposure setting, and the
 * Datastores attached to its App — and hand them to the filter in
 * `domain/placement.ts`. There is nothing here for a developer to fill in,
 * because §3 states plainly that "there is no requirements language and the
 * developer types nothing."
 *
 * It is a **query**: nothing is written. §3 puts resolution before the build so
 * that "nowhere fits" is a returnable answer rather than a deploy that fails
 * later, and an act that recorded a placement would make asking the question
 * change the App.
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  apps,
  components,
  datastores,
  targets,
  vessels,
} from '../../db/schema.ts';
import type { ArtifactType, Auth, Reach } from '../../domain/desired-state.ts';
import {
  DEFAULT_PLATFORM,
  type DerivedRequirements,
  type Exclusion,
  placementTargetOf,
  type RequiredDatastore,
  resolvePlacement,
} from '../../domain/placement.ts';
import { targetLabel } from '../../domain/target.ts';
import { type Command, type CommandContext, failed, ok } from '../types.ts';

export const resolveComponentPlacementInput = z
  .object({
    componentId: z.uuid(),
  })
  .strict();

export type ResolveComponentPlacementInput = z.infer<
  typeof resolveComponentPlacementInput
>;

/** One Target the UI renders, candidate or not. */
export interface PlacementOption {
  readonly targetId: string;
  /** `<vessel>/<adapter>` — the two facts that identify this Target. */
  readonly name: string;
  readonly rank: number;
  /** Candidates are selectable; non-candidates are listed and disabled (§3). */
  readonly candidate: boolean;
  /** What a Build for this placement would produce. Only for candidates. */
  readonly artifactType: ArtifactType | null;
  readonly reasons: readonly Exclusion[];
  readonly detail: readonly string[];
}

export interface ResolveComponentPlacementResult {
  readonly componentId: string;
  /** `null` is a real answer: §3 insists "nowhere fits" be expressible. */
  readonly suggestedTargetId: string | null;
  /** Every Target, in rank order, candidates and non-candidates alike. */
  readonly options: readonly PlacementOption[];
}

export const resolveComponentPlacement: Command<
  ResolveComponentPlacementInput,
  ResolveComponentPlacementResult
> = async (input, context) => {
  const component = (
    await context.db
      .select()
      .from(components)
      .where(eq(components.id, input.componentId))
  )[0];
  if (component === undefined) {
    return failed(
      'NOT_FOUND',
      `there is no Component with id ${input.componentId}`,
    );
  }

  // With the boundary, because half of what names a Target lives there.
  const connected = await context.db.query.targets.findMany({
    where: (targets, { eq }) => eq(targets.status, 'connected'),
    with: { vessel: true },
  });

  // The datastore anchors to its vessel, and placement compares Target ids —
  // a developer picks a Target, not a boundary — so the derivation gains a
  // hop: vessel → its kubernetes surface → that Target's id. A left join on
  // the literal adapter, because only the cluster-local case ever reads it.
  const attached = await context.db
    .select({
      name: datastores.name,
      engine: datastores.engine,
      vesselKind: vessels.kind,
      clusterTargetId: targets.id,
    })
    .from(datastores)
    .innerJoin(apps, eq(datastores.appId, apps.id))
    .innerJoin(vessels, eq(datastores.vesselId, vessels.id))
    .leftJoin(
      targets,
      and(eq(targets.vesselId, vessels.id), eq(targets.adapter, 'kubernetes')),
    )
    .where(and(eq(apps.id, component.appId), isNotNull(datastores.appId)));

  const requirements = derive(
    context,
    component.kind,
    component.reach,
    component.auth,
    component.schedule,
    [
      ...attached.map(
        (datastore): RequiredDatastore => ({
          name: datastore.name,
          engine: datastore.engine,
          // §11: "In-cluster datastores stay cluster-local in v1." A managed
          // cloud database is reachable from anywhere its vessel's project is;
          // one running in a cluster is reachable from that cluster only —
          // and a cluster vessel has exactly one kubernetes surface, so the
          // joined id is never null on this arm.
          clusterLocalTargetId:
            datastore.vesselKind === 'cluster'
              ? datastore.clusterTargetId
              : null,
        }),
      ),
    ],
  );

  const placement = resolvePlacement(
    connected.map((target) =>
      placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      }),
    ),
    requirements,
  );

  const options: PlacementOption[] = [
    ...placement.candidates.map((candidate) => ({
      targetId: candidate.target.id,
      name: targetLabel(candidate.target),
      rank: candidate.target.rank,
      candidate: true,
      artifactType: candidate.artifactType,
      reasons: [] as readonly Exclusion[],
      detail: [] as readonly string[],
    })),
    ...placement.nonCandidates.map((excluded) => ({
      targetId: excluded.target.id,
      name: targetLabel(excluded.target),
      rank: excluded.target.rank,
      candidate: false,
      artifactType: null,
      reasons: excluded.reasons,
      detail: excluded.detail,
    })),
  ].sort((a, b) => a.rank - b.rank);

  return ok({
    componentId: component.id,
    suggestedTargetId: placement.suggested?.target.id ?? null,
    options,
  });
};

/**
 * Derive what the App needs (§3).
 *
 * Deliberately narrow today. Architecture, GPU, persistence, and resource asks
 * are all outputs of detection (§5), which arrives with the build pipeline; until
 * then they take the values that exclude no Target, so placement never rejects a
 * Target for a requirement nothing has actually established. The three
 * requirements that *are* known at this point — kind, exposure, and attached
 * Datastores — are the three §3 and §11 name as decisive.
 *
 * A job's `schedule` joins them: it is authored, not detected, and a Target
 * with nothing to fire it on that cadence is a non-candidate rather than a
 * Deploy that is refused after a build.
 */
function derive(
  context: CommandContext,
  kind: DerivedRequirements['kind'],
  reach: Reach,
  auth: Auth,
  schedule: string | null,
  attached: readonly RequiredDatastore[],
): DerivedRequirements {
  return {
    kind,
    reach,
    auth,
    ...(schedule === null ? {} : { schedule }),
    platform: DEFAULT_PLATFORM,
    registries: context.manifest.supplyChain.registry,
    resources: {},
    gpu: false,
    persistence: false,
    datastores: attached,
    // §10: one store per installation, and the reach rule binds it to the
    // Target a Component is placed on.
    secretStore: context.manifest.secretStore.adapter,
  };
}
