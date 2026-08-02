import { z } from 'zod';
import type { ComponentKind } from '../../domain/desired-state.ts';
import {
  DEFAULT_PLATFORM,
  type Exclusion,
  placementTargetOf,
  resolvePlacement,
} from '../../domain/placement.ts';
import type { TargetListItem, TargetOptionView } from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

export const listTargetsInput = z.object({});
export type ListTargetsInput = z.infer<typeof listTargetsInput>;

export interface ListTargetsResult {
  readonly targets: readonly TargetListItem[];
  readonly options: readonly TargetOptionView[];
}

export const listTargets: Command<ListTargetsInput, ListTargetsResult> = async (
  _input,
  context,
) => {
  const allTargets = await context.db.query.targets.findMany({
    orderBy: (targets, { asc }) => [asc(targets.rank)],
  });

  const targetsList: TargetListItem[] = [];
  const optionsList: TargetOptionView[] = [];

  for (const target of allTargets) {
    const kinds: ComponentKind[] =
      target.adapter === 'static' ? ['website'] : ['service', 'website', 'job'];

    const canonical = (target.connection as { canonicalSuffix?: string })
      ?.canonicalSuffix
      ? `*.${(target.connection as { canonicalSuffix?: string }).canonicalSuffix}`
      : `*.${target.name.toLowerCase().replace(/[^a-z0-9]/g, '')}.apps.internal`;

    const prereqFailures = target.prerequisites
      ?.filter((p) => !p.met && p.detail)
      .map((p) => p.detail!);

    targetsList.push({
      name: target.name,
      adapter: target.adapter,
      rank: target.rank,
      health: target.health,
      prerequisiteFailures:
        prereqFailures && prereqFailures.length > 0
          ? prereqFailures
          : undefined,
      kinds,
      canonical,
    });

    const isConnected = target.status === 'connected';
    const isHealthy = target.health === 'healthy';

    if (isConnected && isHealthy) {
      const placementTarget = placementTargetOf(target, {
        artifactTypes:
          context.adapters.deploy(target.adapter)?.artifactTypes ?? null,
        manifest: context.manifest,
      });

      const placement = resolvePlacement([placementTarget], {
        kind: 'service',
        exposure: 'private',
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
          name: target.name,
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
          name: target.name,
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
        name: target.name,
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

  return ok({
    targets: targetsList,
    options: optionsList,
  });
};
