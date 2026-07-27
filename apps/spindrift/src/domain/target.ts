/**
 * The Target (§13).
 *
 * "**`Target` keeps its name, stays flat, and has exactly one adapter type** —
 * forced, because placement determines artifact shape, so a single 'Cloud'
 * Target would leave a website ambiguous between the two renderings. Splitting
 * them is what makes picking the static Target *mean* public."
 *
 * Flat is the whole design. There is no `Provider` noun above this, and §13 says
 * why one would earn nothing: **the connect act is credential-shaped though the
 * noun is flat**, so one "connect a cloud project" registers both of that
 * project's Targets and the shared thing between them is an argument to a
 * command, not an entity.
 *
 * Two states this file owns:
 *
 * - **Health is a standing checklist, not a connect-time verdict.** Connect
 *   always succeeds; an unmet item makes the Target a non-candidate with a
 *   stated reason. See `capabilities.ts` for the checklist itself.
 * - **Disconnect strands rather than stops.** "Disconnect always works: live
 *   Deploys go `orphaned`, workloads keep running, reconnect re-adopts via
 *   `observe`, and the confirmation names what it strands."
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';

/**
 * How to reach one Target, in whatever terms its adapter needs.
 *
 * Adapter-specific by necessity — a cluster is an API server and a cloud Target
 * is a project — and therefore a discriminated union rather than a bag of
 * nullable columns: a `cloudrun` Target with an API server is not a state the
 * domain has a name for. Core stores this and hands it to the adapter; core
 * never parses a backend's own naming out of it.
 *
 * **No credential is here, in any variant.** §13: "One auth mode — native OIDC
 * federation, nothing stored." A field for a token is a field something will
 * eventually put a token in.
 */
export type TargetConnection =
  | {
      adapter: 'kubernetes';
      /** The API server endpoint (§13's prerequisite is OIDC against it). */
      apiServer: string;
    }
  | {
      adapter: 'cloudrun';
      /** The vessel project this Target deploys into (§14). */
      project: string;
      region: string;
    }
  | {
      adapter: 'static';
      /** The vessel project this Target's sites live in (§14). */
      project: string;
    };

/**
 * Whether the Target passes §13's standing checklist.
 *
 * Two states, not three. A Target is only ever created by the connect act, and
 * that act runs one pass of the checklist before it returns — so there is no
 * moment at which a Target exists and has never been assessed, and no
 * `unknown` for the UI to render as a shrug.
 */
export type TargetHealth = 'healthy' | 'unhealthy';

/**
 * Why a Deploy is no longer core's to manage.
 *
 * §13: disconnect leaves live Deploys `orphaned` and "workloads keep running".
 * That is deliberately **not** a sixth {@link DeployPhase}: the phases are the
 * platform's verdict on a rollout (§6), and a workload that is still perfectly
 * live has no new verdict — what changed is that Spindrift stopped being able to
 * observe it. So orphaning is a core-side timestamp beside the phase, and
 * `deployState` below is the one place the two are read together.
 */
export type DeployState = 'orphaned' | 'live' | 'pending' | 'failed';

/** The two fields {@link deployState} reads. */
export interface DeployStateInput {
  phase: 'PENDING' | 'APPLYING' | 'WAITING' | 'LIVE' | 'FAILED';
  orphanedAt: Date | null;
}

/**
 * What the UI shows for one Deploy.
 *
 * Orphaning wins over the phase, because it is the more recent fact: a Deploy
 * that reads `LIVE` on a disconnected Target is telling the truth about the last
 * thing Spindrift saw and nothing about what is running now.
 */
export function deployState(deploy: DeployStateInput): DeployState {
  if (deploy.orphanedAt !== null) return 'orphaned';
  switch (deploy.phase) {
    case 'LIVE':
      return 'live';
    case 'FAILED':
      return 'failed';
    default:
      return 'pending';
  }
}

/** The Deploy phases a disconnect strands — anything that reached the Target. */
export const STRANDABLE_PHASES = ['APPLYING', 'WAITING', 'LIVE'] as const;

/**
 * The connect act's two shapes (§13).
 *
 * "The connect act is credential-shaped though the noun is flat: one 'connect a
 * cloud project' registers both project-specific Targets, so a `Provider` noun
 * earns nothing." A cluster is one Target; a cloud project is two, and which two
 * is a fact about the cloud rather than a choice the operator makes.
 */
export const CLOUD_ADAPTERS = ['cloudrun', 'static'] as const;

/** Names for the Targets one connect act registers, from the operator's name. */
export function targetNames(
  kind: 'kubernetes' | 'cloud',
  name: string,
): { name: string; adapter: TargetAdapter }[] {
  if (kind === 'kubernetes') return [{ name, adapter: 'kubernetes' }];
  // Suffixed rather than asked for, because the operator connected one project
  // and §13 makes the split a consequence of the model, not a decision.
  return CLOUD_ADAPTERS.map((adapter) => ({
    name: `${name}-${adapter}`,
    adapter,
  }));
}
