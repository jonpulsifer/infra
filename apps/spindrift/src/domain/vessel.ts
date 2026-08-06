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
 * **The discriminant {@link VesselLocation} needs, and nothing else.** It says
 * which shape "where this boundary is" has — `{ apiServer }`, `{ project }`,
 * later `{ host }` — and it decides no behaviour: it does not say which
 * surfaces a vessel carries, it is not reversible from an adapter, and it gates
 * no manifest entry. Which surfaces are on a vessel is what its Targets say,
 * established by probing the boundary rather than read out of its kind.
 *
 * Named for the tenancy container itself rather than for the adapter that
 * drives a surface on it, because those are different axes. Every future value
 * is vendor-shaped in the same way, naming one provider's tenancy container,
 * which is what makes them additive.
 */
export const VESSEL_KINDS = ['cluster', 'gcp-project'] as const;

export type VesselKind = (typeof VESSEL_KINDS)[number];

/**
 * The surfaces a connect act probes a vessel of this kind **for**.
 *
 * A list of questions, not an answer. An entry here means "ask this boundary
 * whether it carries this runtime"; what it carries is whatever the probe
 * established, and the Target rows are where that lands. So a project whose
 * Cloud Run API is switched off is probed for `cloudrun` and has none, and the
 * same surface may appear under two kinds without either becoming ambiguous —
 * a probe answers per vessel, and a table cannot.
 *
 * Adding a backend is adding a row and nothing else in this file.
 */
export const PROBED_SURFACES_BY_VESSEL_KIND = {
  cluster: ['kubernetes'],
  'gcp-project': ['cloudrun', 'static'],
} as const satisfies Record<VesselKind, readonly TargetAdapter[]>;

/** What one connect act asks a vessel of this kind about. */
export function surfacesToProbe(kind: VesselKind): readonly TargetAdapter[] {
  return PROBED_SURFACES_BY_VESSEL_KIND[kind];
}

/**
 * What one probe established about one surface on one vessel.
 *
 * Three arms rather than a boolean, and the third is the load-bearing one: a
 * read either produced an answer or it did not, exactly as
 * `adapters/cloud-discovery.ts` splits `found` from `unavailable`. `absent`
 * says *this boundary does not carry this runtime* — a fact an operator can act
 * on, and the one answer that withholds a Target. `undetermined` says nothing
 * was established, which is what a `403`, a disabled federation or a failed
 * read produce, and it registers the Target unhealthy with the sentence
 * attached: rendering a confident absence off a refused read would tell an
 * operator their project has no Cloud Run when all that happened is nobody
 * could look.
 */
export type SurfaceProbe =
  | { readonly kind: 'carried' }
  | { readonly kind: 'absent'; readonly detail: string }
  | { readonly kind: 'undetermined'; readonly detail: string };

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
 *
 * **There is no `surfaces` here.** Which runtimes this boundary carries is the
 * set of Targets that reference it, and a second copy of that would be a copy
 * the two can disagree about.
 */
export interface Vessel {
  readonly id: string;
  readonly name: string;
  /** {@link VESSEL_KINDS} — the shape of {@link location}, and nothing else. */
  readonly kind: VesselKind;
  readonly location: VesselLocation;
  /**
   * §33's static reachability input. A property of the network the boundary
   * sits on, which is why it is stated once here rather than per surface.
   */
  readonly servedHosts: readonly string[];
  /**
   * §3, and boundary-shaped for the same reason.
   *
   * An entry is a bare host (`ghcr.io`) or a host/namespace (`ghcr.io/owner`),
   * and both spellings are accepted everywhere this is read —
   * {@link import('./desired-state.ts').pullableFrom} is the one predicate
   * that decides it, for both a Build's pull address and, before a Build
   * exists, the registry namespace itself.
   */
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
