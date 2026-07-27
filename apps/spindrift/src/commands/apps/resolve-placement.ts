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
  type Target,
  targets,
} from '../../db/schema.ts';
import {
  deployPathReferences,
  noCapabilities,
  resolveCapabilities,
  type TargetCapabilities,
} from '../../domain/capabilities.ts';
import type { ArtifactType, Exposure } from '../../domain/desired-state.ts';
import {
  DEFAULT_PLATFORM,
  type DerivedRequirements,
  type Exclusion,
  type PlacementTarget,
  type RequiredDatastore,
  resolvePlacement,
} from '../../domain/placement.ts';
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

/**
 * A Target's capabilities as of its last inspection.
 *
 * The two provenances that are not stored are supplied here: from-the-adapter-
 * type comes off the adapter itself, and the derived values are recomputed. A
 * Target whose adapter this installation does not ship, or that has never been
 * inspected, resolves to no capabilities — which excludes it, with a reason,
 * rather than dropping it silently from the list.
 */
function capabilitiesOf(
  context: CommandContext,
  target: Target,
): TargetCapabilities {
  const adapter = context.adapters.deploy(target.adapter);
  const capabilityContext = {
    adapter: target.adapter,
    artifactTypes: adapter?.artifactTypes ?? [],
    publicExposure: target.publicExposure,
    deployPath: deployPathReferences(context.manifest),
  };
  return target.discovery === null || adapter === null
    ? noCapabilities(capabilityContext)
    : resolveCapabilities(target.discovery, capabilityContext);
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

  const connected = await context.db
    .select()
    .from(targets)
    .where(eq(targets.status, 'connected'));

  const attached = await context.db
    .select({
      name: datastores.name,
      engine: datastores.engine,
      targetId: datastores.targetId,
      targetAdapter: targets.adapter,
    })
    .from(datastores)
    .innerJoin(apps, eq(datastores.appId, apps.id))
    .innerJoin(targets, eq(datastores.targetId, targets.id))
    .where(and(eq(apps.id, component.appId), isNotNull(datastores.appId)));

  const requirements = derive(context, component.kind, component.exposure, [
    ...attached.map(
      (datastore): RequiredDatastore => ({
        name: datastore.name,
        engine: datastore.engine,
        // §11: "In-cluster datastores stay cluster-local in v1." A managed
        // cloud database is reachable from anywhere its Target's project is;
        // one running in a cluster is reachable from that cluster only.
        clusterLocalTargetId:
          datastore.targetAdapter === 'kubernetes' ? datastore.targetId : null,
      }),
    ),
  ]);

  const placement = resolvePlacement(
    connected.map(
      (target): PlacementTarget => ({
        id: target.id,
        name: target.name,
        adapter: target.adapter,
        rank: target.rank,
        healthy: target.health === 'healthy',
        capabilities: capabilitiesOf(context, target),
      }),
    ),
    requirements,
  );

  const options: PlacementOption[] = [
    ...placement.candidates.map((candidate) => ({
      targetId: candidate.target.id,
      name: candidate.target.name,
      rank: candidate.target.rank,
      candidate: true,
      artifactType: candidate.artifactType,
      reasons: [] as readonly Exclusion[],
      detail: [] as readonly string[],
    })),
    ...placement.nonCandidates.map((excluded) => ({
      targetId: excluded.target.id,
      name: excluded.target.name,
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
 */
function derive(
  context: CommandContext,
  kind: DerivedRequirements['kind'],
  exposure: Exposure,
  attached: readonly RequiredDatastore[],
): DerivedRequirements {
  return {
    kind,
    exposure,
    platform: DEFAULT_PLATFORM,
    resources: {},
    gpu: false,
    persistence: false,
    datastores: attached,
    // §10: one store per installation, and the reach rule binds it to the
    // Target a Component is placed on.
    secretStore: context.manifest.secretStore.adapter,
  };
}
