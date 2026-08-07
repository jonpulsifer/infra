import { z } from 'zod';
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import { targetConnectionDivergence } from '../../config/manifest-store.ts';
import { KINDS_BY_ADAPTER } from '../../domain/capabilities.ts';
import { auth, componentKind, reach } from '../../domain/creation-draft.ts';
import type { ComponentKind } from '../../domain/desired-state.ts';
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
import { surfacesToProbe, type VesselLocation } from '../../domain/vessel.ts';
import type {
  CloudBoundaryFacts,
  PendingTargetConnection,
  TargetListItem,
  TargetOptionView,
} from '../../web/model.ts';
import { type Command, ok } from '../types.ts';

/**
 * The three requirements placement is derived from (§3).
 *
 * Optional, and their absence is not a default: a caller that does not say what
 * it is placing gets no `options` at all. The alternative — resolving against a
 * plausible-looking workload — is what made this command answer for a
 * `service`/`private`/`proxy` App no matter what the caller was actually
 * creating, so a `website` was offered Targets that were candidates for
 * something else.
 */
export const listTargetsInput = z.object({
  kind: componentKind.optional(),
  reach: reach.optional(),
  auth: auth.optional(),
});
export type ListTargetsInput = z.infer<typeof listTargetsInput>;

/**
 * The naming boundary a Target's canonical names would live under (§9).
 *
 * Not a minted name — neither call site here has an App or a Component yet,
 * so there is nothing to run `hostnameFor` on. This states the zone the mint
 * would land in, which is the honest thing the Targets screen and the Place
 * step can say before that: `<app>-<component>` is not known, but the zone it
 * would be joined to is.
 *
 * `null` is not "unknown" — it is the correct answer for `cloudrun` and
 * `static`. `coreMintsCanonical` is false for both: the platform mints its
 * own workload address, and inventing a Spindrift-owned suffix beside it
 * would show a naming pattern no Deploy on that Target will ever use. Every
 * caller must render `null` as "the platform names its own" rather than
 * fall back to a suffix — a fallback here is exactly the bug this replaced
 * (`*.<target>.apps.internal`, a zone that appeared nowhere else in the
 * repo).
 */
function canonicalBoundary(
  adapter: TargetAdapter,
  zones: DnsZones,
): string | null {
  if (!coreMintsCanonical(adapter)) return null;
  // One zone per reach (§9's `DnsZones`): an installation may point both at
  // the same name, so collapsing to one pattern is both honest and the common
  // case; an installation that split them gets both, because a Target minting
  // into `public` as readily as `private` is not represented by naming only
  // one.
  return zones.private === zones.public
    ? `*.${zones.private}`
    : `*.${zones.private} (private) · *.${zones.public} (public)`;
}

/** A Target row with the boundary it sits on, as {@link editStart} reads it. */
type SurfaceOnVessel = OnboardingTargetRow & {
  readonly vessel: OnboardingTargetRow['vessel'] & {
    readonly location: VesselLocation | null;
    readonly servedHosts: readonly string[] | null;
    readonly reachableRegistries: readonly string[] | null;
  };
};

/**
 * The facts a cloud edit has to restate — see `TargetListItem.edit`.
 *
 * Read off the boundary and off its runtime surface, because that is where
 * `connectTarget` put them: one act supplied them once and fanned them out, so
 * an edit that re-runs the act has to hand them all back or the act deletes
 * them.
 */
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
 * Where an edit of this Target's connection starts — `TargetListItem.edit`.
 *
 * A cluster's values come from this Target alone, which is the whole difference
 * between an edit and a connect: `connectionProposal` prefers a healthy donor
 * of the same adapter, and given a list of one there is only this row to read.
 * A donor's values on an edit screen would be the second cluster's address
 * problem with the Targets the other way round.
 *
 * A cloud edit reads this boundary's surfaces **together**, because one connect
 * writes them together: the region and the runtime endpoint are on `cloudrun`
 * and the hosting endpoint on `static`, so an edit opened from either that read
 * only itself would drop the other one's fact. Behind them come the
 * installation's other cloud Targets, because those three values are
 * installation-wide rather than this project's — and that is what makes the
 * edit usable as the re-probe: a vessel whose runtime surface the last probe
 * did not find has no `cloudrun` row of its own to read an endpoint off.
 *
 * Offered only for a surface the boundary's connect act probes for. Editing is
 * that act run again, so a surface outside its list is one this form would not
 * write — and a control that does not touch the row it hangs off is worse than
 * none.
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
  // The address is the vessel's, not the surface's — which is exactly why an
  // edit may state it where a proposal may not.
  return location.kind === 'cluster'
    ? {
        kind: 'cluster',
        apiServer: location.apiServer,
        proposal: connectionProposal([target], 'cluster'),
      }
    : {
        kind: 'gcp-project',
        project: location.project,
        carried: carriedFacts(target.vessel, onVessel),
        // This boundary's own surfaces first, the installation's others behind
        // them: a region and two API endpoints are installation-wide facts a
        // fresh connect already carries from any working cloud Target, so the
        // vessel whose runtime surface is not registered *yet* is exactly the
        // case where another project's are the right thing to offer.
        proposal: connectionProposal(
          [
            ...onVessel,
            ...allTargets.filter((row) => row.vessel.id !== target.vessel.id),
          ],
          'gcp-project',
        ),
      };
}

export interface ListTargetsResult {
  readonly targets: readonly TargetListItem[];
  readonly options: readonly TargetOptionView[];
  /** Connect acts this installation is waiting on — the onboarding surface. */
  readonly pending: readonly PendingTargetConnection[];
}

export const listTargets: Command<ListTargetsInput, ListTargetsResult> = async (
  input,
  context,
) => {
  const allTargets = await context.db.query.targets.findMany({
    // The boundary comes with every surface: it is half of what an adapter is
    // handed, and it is what groups these rows into connect acts.
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
      prerequisites: (target.prerequisites ?? []).map((item) => ({
        name: item.name,
        met: item.met,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      })),
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
    });

    const isConnected = target.status === 'connected';
    const isHealthy = target.health === 'healthy';

    if (requirements === null) {
      // Nothing to place, so nothing to say about placement. The Targets screen
      // reads `targets` and never `options`, which is why this is silence
      // rather than a guess.
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

  return ok({
    targets: targetsList,
    options: optionsList,
    pending: pendingConnections(allTargets),
  });
};
