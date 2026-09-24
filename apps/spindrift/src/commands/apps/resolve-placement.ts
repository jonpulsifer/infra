/**
 * `resolveComponentPlacement`: which connected Targets this Component can go on,
 * and why the others are excluded. A query; nothing is written.
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

export interface PlacementOption {
  readonly targetId: string;
  /** `<vessel>/<adapter>`. */
  readonly name: string;
  readonly rank: number;
  /** Candidates are selectable; non-candidates are listed and disabled. */
  readonly candidate: boolean;
  /** What a Build here would produce; `null` for a non-candidate. */
  readonly artifactType: ArtifactType | null;
  readonly reasons: readonly Exclusion[];
  readonly detail: readonly string[];
}

export interface ResolveComponentPlacementResult {
  readonly componentId: string;
  /** `null` when nowhere fits. */
  readonly suggestedTargetId: string | null;
  /** Every connected Target in rank order, candidate or not. */
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

  const connected = await context.db.query.targets.findMany({
    where: (targets, { eq }) => eq(targets.status, 'connected'),
    with: { vessel: true },
  });

  // A datastore anchors to a vessel and placement compares Target ids, so left
  // join the vessel's kubernetes Target, which only a cluster vessel needs.
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
          // An in-cluster datastore is reachable from its cluster only. A
          // cluster vessel has one kubernetes Target, so this is never null.
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
 * Platform, GPU, persistence and resources take values that exclude no Target,
 * so none is rejected on a requirement nothing has established.
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
    // One secret store per installation.
    secretStore: context.manifest.secretStore.adapter,
  };
}
