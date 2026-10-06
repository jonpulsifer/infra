import { z } from 'zod';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { targetConnectionDivergence } from '../../config/manifest-store.ts';
import { KINDS_BY_ADAPTER } from '../../domain/capabilities.ts';
import { auth, componentKind, reach } from '../../domain/creation-draft.ts';
import type { ComponentKind, Reach } from '../../domain/desired-state.ts';
import { coreMintsCanonical, type DnsZones } from '../../domain/naming.ts';
import {
  DEFAULT_PLATFORM,
  type Exclusion,
  placementTargetOf,
  resolvePlacement,
} from '../../domain/placement.ts';
import {
  connectionProposal,
  type OnboardingTargetRow,
  pendingConnections,
} from '../../domain/target-onboarding.ts';
import {
  deriveVesselHealth,
  surfacesToProbe,
  type VesselLocation,
  vesselRolesOf,
} from '../../domain/vessel.ts';
import { type Command, ok } from '../types.ts';
import type {
  CloudBoundaryFacts,
  PendingTargetConnection,
  PrerequisiteRowView,
  TargetListItem,
  TargetOptionView,
  VesselListItem,
} from '../views.ts';
import {
  type BoundaryFacts,
  remediationSubject,
  withRemediations,
} from './remediation.ts';

/** Placement `options` are listed only when all three are given. */
export const listTargetsInput = z.object({
  kind: componentKind.optional(),
  reach: reach.optional(),
  auth: auth.optional(),
});
export type ListTargetsInput = z.infer<typeof listTargetsInput>;

/**
 * The zones this Target's canonical names would join. `null` where the platform
 * names its own workloads or no zone serves the Target's reach.
 */
function canonicalBoundary(
  adapter: TargetAdapter,
  zones: DnsZones,
  reaches: readonly Reach[] | null,
): string | null {
  if (!coreMintsCanonical(adapter)) return null;
  // Unknown reach matches every zone.
  const served = zones.filter((zone) =>
    zone.reaches.some((reach) => reaches?.includes(reach) ?? true),
  );
  if (served.length === 0) return null;
  return served
    .map((zone) =>
      zone.reaches.length === 1
        ? `*.${zone.name} (${zone.reaches[0]})`
        : `*.${zone.name}`,
    )
    .join(' · ');
}

type SurfaceOnVessel = OnboardingTargetRow & {
  readonly vessel: OnboardingTargetRow['vessel'] & {
    readonly location: VesselLocation | null;
    readonly servedHosts: readonly string[] | null;
    readonly reachableRegistries: readonly string[] | null;
  };
};

/** Facts an edit must hand back, or re-running `connectTarget` drops them. */
function carriedFacts(
  vessel: SurfaceOnVessel['vessel'],
  onVessel: readonly SurfaceOnVessel[],
): CloudBoundaryFacts {
  const run = onVessel.find(
    (row) => row.connection?.adapter === 'cloudrun',
  )?.connection;
  const runtime = run?.adapter === 'cloudrun' ? run : null;
  return {
    ...(runtime?.serviceAccount === undefined
      ? {}
      : { serviceAccount: runtime.serviceAccount }),
    ...(runtime?.logHistorySeconds === undefined
      ? {}
      : { logHistorySeconds: runtime.logHistorySeconds }),
    ...(vessel.servedHosts === null
      ? {}
      : { servedHosts: [...vessel.servedHosts] }),
    ...(vessel.reachableRegistries === null
      ? {}
      : { reachableRegistries: [...vessel.reachableRegistries] }),
  };
}

/**
 * Editing re-runs `connectTarget`, so only a surface it probes is editable. A
 * cluster edit reads only this Target, never another cluster's values.
 */
function editStart(
  target: SurfaceOnVessel,
  allTargets: readonly SurfaceOnVessel[],
): TargetListItem['edit'] {
  const location = target.vessel.location;
  if (target.connection === null || location === null) return null;
  if (!surfacesToProbe(location.kind).includes(target.adapter)) return null;

  const onVessel = allTargets.filter(
    (row) => row.vessel.id === target.vessel.id,
  );
  if (location.kind === 'cluster') {
    return {
      kind: 'cluster',
      apiServer: location.apiServer,
      proposal: connectionProposal([target], 'cluster'),
    };
  }
  if (location.kind === 'vercel-team') {
    return {
      kind: 'vercel-team',
      team: location.team,
      proposal: connectionProposal([target], 'vercel-team'),
    };
  }
  if (location.kind === 'cloudflare-account') {
    // One surface holds the one endpoint, so the proposal carries everything.
    return {
      kind: 'cloudflare-account',
      account: location.account,
      proposal: connectionProposal(onVessel, 'cloudflare-account'),
    };
  }
  return {
    kind: 'gcp-project',
    project: location.project,
    carried: carriedFacts(target.vessel, onVessel),
    // This vessel's surfaces first. Region and endpoints are installation-wide,
    // so other projects fill in for a surface this vessel lacks.
    proposal: connectionProposal(
      [
        ...onVessel,
        ...allTargets.filter((row) => row.vessel.id !== target.vessel.id),
      ],
      'gcp-project',
    ),
  };
}

function boundaryOf(
  vessel: { readonly id: string; readonly name: string },
  location: VesselLocation | null,
  allTargets: readonly SurfaceOnVessel[],
): BoundaryFacts {
  return {
    name: vessel.name,
    location,
    surfaces: allTargets.filter((row) => row.vessel.id === vessel.id),
  };
}

function checklistView(
  items: readonly {
    readonly name: PrerequisiteRowView['name'];
    readonly met: boolean;
    readonly detail?: string;
    readonly remediation?: PrerequisiteRowView['remediation'];
  }[],
): readonly PrerequisiteRowView[] {
  return items.map((item) => ({
    name: item.name,
    met: item.met,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.remediation === undefined
      ? {}
      : { remediation: item.remediation }),
  }));
}

export interface ListTargetsResult {
  readonly targets: readonly TargetListItem[];
  readonly options: readonly TargetOptionView[];
  /** Connect acts this installation is waiting on. */
  readonly pending: readonly PendingTargetConnection[];
  /** Each vessel with its own checklist, oldest first. */
  readonly vessels: readonly VesselListItem[];
}

export const listTargets: Command<ListTargetsInput, ListTargetsResult> = async (
  input,
  context,
) => {
  const allTargets = await context.db.query.targets.findMany({
    with: { vessel: true },
    orderBy: (targets, { asc }) => [asc(targets.rank)],
  });

  const requirements =
    input.kind === undefined ||
    input.reach === undefined ||
    input.auth === undefined
      ? null
      : { kind: input.kind, reach: input.reach, auth: input.auth };

  const targetsList: TargetListItem[] = [];
  const optionsList: TargetOptionView[] = [];

  for (const target of allTargets) {
    const kinds: ComponentKind[] = [...KINDS_BY_ADAPTER[target.adapter]];

    const canonical = canonicalBoundary(
      target.adapter,
      context.manifest.dns.zones,
      target.reaches,
    );

    const prereqFailures = target.prerequisites
      ?.filter((p) => !p.met && p.detail)
      .map((p) => p.detail!);

    targetsList.push({
      id: target.id,
      vessel: target.vessel.name,
      adapter: target.adapter,
      rank: target.rank,
      health: target.health,
      prerequisiteFailures:
        prereqFailures && prereqFailures.length > 0
          ? prereqFailures
          : undefined,
      prerequisites: checklistView(
        withRemediations(
          target.prerequisites ?? [],
          remediationSubject(
            context.manifest,
            boundaryOf(target.vessel, target.vessel.location, allTargets),
            target.adapter,
          ),
        ),
      ),
      kinds,
      canonical,
      status: target.status,
      configured: target.connection !== null,
      inspectedAt: target.inspectedAt?.toISOString() ?? null,
      connectionDivergence: targetConnectionDivergence(
        context.manifest.targets.find(
          (seed) =>
            seed.vessel === target.vessel.name &&
            seed.adapter === target.adapter,
        ),
        target.connection,
      ),
      edit: editStart(target, allTargets),
      vesselRoles: vesselRolesOf(context.manifest, target.vessel.name),
    });

    const isConnected = target.status === 'connected';
    const isHealthy = target.health === 'healthy';

    if (requirements === null) {
      // Nothing to place, so no options.
    } else if (isConnected && isHealthy) {
      const placementTarget = placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      });

      const placement = resolvePlacement([placementTarget], {
        ...requirements,
        platform: DEFAULT_PLATFORM,
        registries: context.manifest.supplyChain.registry,
        resources: {},
        gpu: false,
        persistence: false,
        datastores: [],
        secretStore: context.manifest.secretStore.adapter,
      });

      if (placement.candidates.length > 0) {
        const candidate = placement.candidates[0]!;
        optionsList.push({
          targetId: target.id,
          vessel: target.vessel.name,
          adapter: target.adapter,
          rank: target.rank,
          candidate: true,
          artifactType: candidate.artifactType,
          canonical,
          reasons: [],
          detail: [],
        });
      } else {
        const excluded = placement.nonCandidates[0]!;
        optionsList.push({
          targetId: target.id,
          vessel: target.vessel.name,
          adapter: target.adapter,
          rank: target.rank,
          candidate: false,
          artifactType: null,
          canonical,
          reasons: excluded.reasons,
          detail: excluded.detail,
        });
      }
    } else {
      const reasons: Exclusion[] = [];
      const detail: string[] = [];
      if (!isConnected) {
        reasons.push('TARGET_DISCONNECTED' as unknown as Exclusion);
        detail.push('Target is disconnected');
      }
      if (!isHealthy) {
        reasons.push('UNHEALTHY');
        const prereqFailures = target.prerequisites
          ?.filter((p) => !p.met && p.detail)
          .map((p) => p.detail!);
        if (prereqFailures && prereqFailures.length > 0) {
          detail.push(...prereqFailures);
        } else {
          detail.push('Target health checklist failed');
        }
      }

      optionsList.push({
        targetId: target.id,
        vessel: target.vessel.name,
        adapter: target.adapter,
        rank: target.rank,
        candidate: false,
        artifactType: null,
        canonical,
        reasons,
        detail,
      });
    }
  }

  const vesselRows = await context.db.query.vessels.findMany({
    orderBy: (vessels, { asc }) => [asc(vessels.createdAt), asc(vessels.name)],
  });

  return ok({
    targets: targetsList,
    options: optionsList,
    pending: pendingConnections(allTargets),
    vessels: vesselRows.map((vessel) => {
      const roles = vesselRolesOf(context.manifest, vessel.name);
      const prerequisites = vessel.prerequisites ?? [];
      return {
        name: vessel.name,
        kind: vessel.kind,
        roles,
        // Derived on read: a release can add checklist rows a stored verdict
        // would miss.
        health: deriveVesselHealth(prerequisites, vessel.kind, roles),
        prerequisites: checklistView(
          withRemediations(
            prerequisites,
            remediationSubject(
              context.manifest,
              boundaryOf(vessel, vessel.location, allTargets),
              null,
            ),
          ),
        ),
        inspectedAt: vessel.inspectedAt?.toISOString() ?? null,
        discovery: vessel.discovery,
      };
    }),
  });
};
