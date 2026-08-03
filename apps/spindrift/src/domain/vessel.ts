/**
 * The Vessel — the tenancy boundary a Target is a surface on (§13, §14).
 *
 * §13 declined a second noun above `Target`: "the connect act is
 * credential-shaped though the noun is flat, so one 'connect a cloud project'
 * registers both of that project's Targets and the shared thing between them is
 * an argument to a command, not an entity."
 *
 * That reasoning holds for the *split* and not for the absence of the noun. A
 * cloud project genuinely is two Targets, because placement determines artifact
 * shape and a single "Cloud" Target would leave a website ambiguous between the
 * Cloud Run rendering and the static one. What follows from that is
 * **Target = Vessel × runtime surface**, not that the vessel does not exist —
 * and the vessel did exist, spelled as a name prefix that four separate places
 * sliced back off:
 *
 * - the fan-out that minted `<project>-cloudrun` and `<project>-static`,
 * - `cloudProjectOf` in `target-onboarding.ts`, recovering it for the UI,
 * - a `superRefine` in the manifest schema validating the convention,
 * - and `project` / `servedHosts` duplicated across both connections, where two
 *   surfaces of one boundary could state different values for one fact.
 *
 * The forcing argument is what comes next. Every backend worth adding is a
 * boundary hosting several runtimes: an edge platform's account serves static
 * sites *and* runs functions, and both are one tenancy boundary with one
 * credential. So the suffix convention gets load-bearing rather than cheaper.
 *
 * **The adapter seam does not move.** `deployTargetOf` composes the flat
 * `TargetConnection` an adapter already receives out of two rows instead of one,
 * so `DeployAdapter`, `DeployTarget`, and every conformance test are untouched.
 * This is a core-side normalization, not a change to §6's contract.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';

/**
 * What kind of boundary this is.
 *
 * Named for the tenancy container itself rather than for the adapter that
 * drives a surface on it, because those are different axes: a `gcp-project`
 * carries two adapters, and `kubernetes` is one adapter on a `cluster`. Every
 * future value is vendor-shaped in the same way, naming one provider's tenancy
 * container, which is what makes them additive.
 */
export const VESSEL_KINDS = ['cluster', 'gcp-project'] as const;

export type VesselKind = (typeof VESSEL_KINDS)[number];

/**
 * The surfaces each kind of vessel carries (§13's split, as a table).
 *
 * This replaces `targetNames()` and `CLOUD_ADAPTERS`. One connect act registers
 * one row per entry here, which is the same behaviour as before — stated as a
 * fact about the vessel kind rather than as a branch on the word "cloud".
 *
 * Adding a backend is adding a row — one vessel kind mapped to the surfaces it
 * serves — and needs nothing else in this file.
 */
export const SURFACES_BY_VESSEL_KIND = {
  cluster: ['kubernetes'],
  'gcp-project': ['cloudrun', 'static'],
} as const satisfies Record<VesselKind, readonly TargetAdapter[]>;

/** The surfaces one connect act registers on a vessel of this kind. */
export function surfacesOf(kind: VesselKind): readonly TargetAdapter[] {
  return SURFACES_BY_VESSEL_KIND[kind];
}

/** Which kind of vessel carries this surface. */
export function vesselKindFor(adapter: TargetAdapter): VesselKind {
  for (const kind of VESSEL_KINDS) {
    if (
      (SURFACES_BY_VESSEL_KIND[kind] as readonly string[]).includes(adapter)
    ) {
      return kind;
    }
  }
  // Unreachable while the table above covers every adapter, which
  // `satisfies Record<VesselKind, ...>` and the test in
  // `test/domain/vessel.test.ts` between them keep true.
  throw new Error(`no vessel kind carries the ${adapter} surface`);
}

/**
 * Where the boundary is, in its own kind's terms.
 *
 * A discriminated union rather than nullable columns, for the reason
 * `TargetConnection` gives: a `cluster` with a project id is not a state the
 * domain has a name for.
 *
 * **No credential, in either arm** (§13). What authorizes a call is minted per
 * request by whatever federates.
 */
export type VesselLocation = ClusterLocation | GcpProjectLocation;

export interface ClusterLocation {
  kind: 'cluster';
  /** The API server endpoint. §13's prerequisite is OIDC against it. */
  apiServer: string;
}

export interface GcpProjectLocation {
  kind: 'gcp-project';
  /** The project every surface on this vessel deploys into (§14). */
  project: string;
}

/**
 * The Vessel row, as the domain reads it.
 *
 * Everything here is a fact about the boundary — true for every surface on it,
 * and therefore impossible for two of them to disagree about. A fact that is
 * true of one surface and not another belongs on the Target.
 */
export interface Vessel {
  readonly id: string;
  readonly name: string;
  readonly kind: VesselKind;
  readonly location: VesselLocation;
  /**
   * §33's static reachability input. A property of the network the boundary
   * sits on, which is why it is stated once here rather than per surface.
   */
  readonly servedHosts: readonly string[];
  /** §3, and boundary-shaped for the same reason. */
  readonly reachableRegistries: readonly string[];
}

/**
 * Reconcile what two surfaces of one boundary each claimed about it.
 *
 * Used by the backfill and by manifest seeding, which are the two paths where a
 * per-surface statement of a boundary fact still arrives. The union rather than
 * a winner: today the two *can* disagree, and silently taking one would be the
 * bug this noun exists to prevent. Callers log when the inputs differ.
 */
export function unionOfClaims(
  claims: readonly (readonly string[] | undefined)[],
): string[] {
  return [...new Set(claims.flatMap((claim) => claim ?? []))].sort();
}

/** Whether two surfaces stated different things about one boundary fact. */
export function claimsDisagree(
  claims: readonly (readonly string[] | undefined)[],
): boolean {
  const stated = claims.filter((claim) => claim !== undefined);
  if (stated.length < 2) return false;
  const first = JSON.stringify([...(stated[0] ?? [])].sort());
  return stated.some((claim) => JSON.stringify([...claim].sort()) !== first);
}
