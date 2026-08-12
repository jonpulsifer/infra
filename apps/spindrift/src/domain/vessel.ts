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
import type {
  AuthoredManifest,
  TargetAdapter,
} from '../config/manifest.schema.ts';
import type { Remediation } from './remediation.ts';

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
export const VESSEL_KINDS = ['cluster', 'gcp-project', 'vercel-team'] as const;

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
  // One today. The file header's "an edge platform's account serves static
  // sites *and* runs functions" is this boundary, and the second surface is a
  // row here on the day a build route emits `.vercel/output` with functions in
  // it — which is what the deploy adapter is already shaped to hand over.
  'vercel-team': ['vercel'],
} as const satisfies Record<VesselKind, readonly TargetAdapter[]>;

/** What one connect act asks a vessel of this kind about. */
export function surfacesToProbe(kind: VesselKind): readonly TargetAdapter[] {
  return PROBED_SURFACES_BY_VESSEL_KIND[kind];
}

/**
 * What one vessel is to this installation, as opposed to what it is made of.
 *
 * The second axis of the prerequisite catalogue below. `kind` says what shape a
 * boundary's address has; this says what the installation asks of it — and the
 * two are independent, which is why they are two axes rather than more kinds.
 *
 * A vessel can hold more than one role: nothing stops an installation whose
 * control plane runs on the same boundary its shared services live in, and a
 * scalar role would have to pick one and drop the other's rows.
 */
export const VESSEL_ROLES = ['home', 'controlPlane', 'app'] as const;

export type VesselRole = (typeof VESSEL_ROLES)[number];

/**
 * Which roles this installation's manifest puts on one vessel, by name.
 *
 * `app` is the answer for everything the two pointers do not name — not an
 * absence, because an ordinary deploy boundary is a role rather than the lack of
 * one, and the catalogue has to be able to key off it.
 */
export function vesselRolesOf(
  manifest: Pick<AuthoredManifest, 'installation'>,
  vessel: string,
): readonly VesselRole[] {
  const roles: VesselRole[] = [];
  if (vessel === manifest.installation.homeVessel) roles.push('home');
  if (vessel === manifest.installation.controlPlaneVessel) {
    roles.push('controlPlane');
  }
  return roles.length === 0 ? ['app'] : roles;
}

/**
 * Every prerequisite a vessel can be asked about, as distinct from a surface on
 * one (§13's checklist is `PREREQUISITES` in `capabilities.ts`).
 *
 * These are the four the home vessel exists to hold, and none of them belongs to
 * a Target: a source bucket is where a build's bytes are staged before any
 * placement is known, an artifacts project is shared across every vessel (§14),
 * the store of record is one place whatever reaches it, and the signer is a key
 * core calls rather than a Target does. Assessing them on a Target would put the
 * same row on three screens and let them disagree.
 */
export const VESSEL_PREREQUISITES = [
  'SOURCE_BUCKET',
  'SECRET_STORE',
  'SIGNER_KEY',
  'ARTIFACTS_PROJECT',
] as const;

export type VesselPrerequisite = (typeof VESSEL_PREREQUISITES)[number];

/**
 * The checklist one vessel is assessed against, by kind **and** role.
 *
 * `PREREQUISITES_BY_ADAPTER` keys off adapter for the reason `capabilities.ts`
 * states — "a checklist row that can never fail is a row that teaches a reader
 * the wrong thing about what was checked" — and the same argument runs one axis
 * over. An app vessel has no source bucket, no store container and no signer of
 * its own; showing it four permanently-green rows would say those were checked
 * when nothing looked.
 *
 * Kind matters as well as role because every one of these reads is a cloud API
 * call. A cluster that somehow held the shared services would be assessed
 * against nothing rather than against four questions no code here knows how to
 * ask it — which is the honest answer until something does.
 */
export const VESSEL_PREREQUISITES_BY_KIND_AND_ROLE = {
  cluster: { home: [], controlPlane: [], app: [] },
  'gcp-project': {
    home: ['SOURCE_BUCKET', 'SECRET_STORE', 'SIGNER_KEY', 'ARTIFACTS_PROJECT'],
    controlPlane: [],
    app: [],
  },
  // The shared services are cloud objects and nothing here knows how to ask an
  // edge platform for them, so an installation cannot make this boundary its
  // home. Empty rather than four permanently-red rows: see the header above.
  'vercel-team': { home: [], controlPlane: [], app: [] },
} as const satisfies Record<
  VesselKind,
  Record<VesselRole, readonly VesselPrerequisite[]>
>;

/**
 * What a vessel of this kind in these roles is asked, in display order.
 *
 * The union over its roles rather than one row, so a boundary that is both the
 * home and the control plane is asked everything either role owes. Ordered by
 * {@link VESSEL_PREREQUISITES} so two vessels never show the same rows in
 * different orders.
 */
export function vesselPrerequisitesFor(
  kind: VesselKind,
  roles: readonly VesselRole[],
): readonly VesselPrerequisite[] {
  const asked = new Set(
    roles.flatMap((role) => [
      ...VESSEL_PREREQUISITES_BY_KIND_AND_ROLE[kind][role],
    ]),
  );
  return VESSEL_PREREQUISITES.filter((name) => asked.has(name));
}

/** One checklist item on a vessel, and the sentence behind an unmet one. */
export interface VesselPrerequisiteResult {
  readonly name: VesselPrerequisite;
  readonly met: boolean;
  /** Why it is unmet. §3's grammar: an exclusion carries its reason. */
  readonly detail?: string;
  /**
   * Whether a read reached a verdict on this row — a Target's `assessed` one
   * noun up, and load-bearing for the same reason.
   *
   * `false` is `Discovered`'s `unavailable` arm arriving here intact: a refused
   * or unreachable listing establishes nothing, and `holds` keeps it apart from
   * an established absence precisely so that nothing downstream can treat a
   * boundary that would not answer as a boundary that answered no.
   */
  readonly assessed?: boolean;
  /**
   * What would clear it, as Terraform — a Target's `remediation` one noun up,
   * and composed at read time for the same reason.
   */
  readonly remediation?: Remediation;
}

/**
 * The checklist for a vessel nothing could be asked about.
 *
 * The vessel-level twin of `unreachablePrerequisites`: an installation with no
 * federation, or a process with no cloud client, produces every catalogued row
 * unmet with the fault stated rather than no rows at all.
 */
export function unreachableVesselPrerequisites(
  detail: string,
  kind: VesselKind,
  roles: readonly VesselRole[],
): readonly VesselPrerequisiteResult[] {
  return vesselPrerequisitesFor(kind, roles).map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

/**
 * Healthy is every catalogued item met — including the vacuous case.
 *
 * An app vessel is asked nothing and is therefore healthy, which is the right
 * answer rather than a loophole: it holds nothing this installation depends on,
 * so there is nothing about it that can be broken here. The Targets on it carry
 * their own checklist and fail on their own terms.
 */
export function deriveVesselHealth(
  prerequisites: readonly VesselPrerequisiteResult[],
  kind: VesselKind,
  roles: readonly VesselRole[],
): 'healthy' | 'unhealthy' {
  const met = new Set(
    prerequisites.filter((item) => item.met).map((i) => i.name),
  );
  return vesselPrerequisitesFor(kind, roles).every((name) => met.has(name))
    ? 'healthy'
    : 'unhealthy';
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
export type VesselLocation =
  | ClusterLocation
  | GcpProjectLocation
  | VercelTeamLocation;

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

export interface VercelTeamLocation {
  kind: 'vercel-team';
  /**
   * The team or account every surface on this vessel deploys into.
   *
   * Not spelled `project`, though the field one arm up is: a Vercel project is
   * one site inside this boundary — the adapter creates one per Component —
   * and reusing the word would make the tenancy boundary and the thing placed
   * on it the same noun.
   */
  team: string;
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
