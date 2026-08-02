/**
 * `DesiredState` rendered as one Cloud Run Service (§6).
 *
 * §6 settles the direction of the seam: **core describes, the adapter renders.**
 * This file is the rendering, kept apart from the adapter that applies it for
 * the reason `dns/cr.ts` is kept apart from the client that writes it — a pure
 * function returning a plain object is a document a test can assert on exactly,
 * without a fake API standing by to catch it.
 *
 * **Never the build-from-source path** (§4). The runtime's own convenience path
 * would take a source archive and build it, which is a second engine with its
 * own frontends and its own idea of what a website is: §4's "build is always
 * separate from deploy" applied one level down. What is rendered here therefore
 * carries an image and nothing that could cause a build — and
 * {@link cloudRunService} is where a test asserts that, because it is the whole
 * document.
 */
import type {
  ConfigEntry,
  DesiredState,
  Exposure,
} from '../../../domain/desired-state.ts';
import { workloadName } from '../../../domain/workload-name.ts';

/** The ingress settings the runtime accepts, in its own vocabulary. */
export const INGRESS = {
  all: 'INGRESS_TRAFFIC_ALL',
  internalOnly: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
} as const;

/**
 * The port a container is contacted on.
 *
 * Fixed rather than configurable, matching §7's fixed port for the chart: the
 * runtime passes it as `PORT` and every zero-config build honours that, so a
 * per-Component port would be a knob whose only effect is to break the ones
 * that read the variable.
 */
export const CONTAINER_PORT = 8080;

/** What the caller must supply that `DesiredState` does not carry. */
export interface CloudRunRenderContext {
  /** The vessel project the Service lives in (§14). */
  readonly project: string;
  /** The image the revision pulls, pinned by digest where the artifact has one. */
  readonly image: string;
  /**
   * The identity the revision runs as (§14), or `null` to let the runtime pick.
   *
   * Letting it pick is what the absent case *means*, and it is worth naming
   * because it does not fail where it is chosen: the runtime substitutes the
   * project's default compute account, and the apply is then refused for
   * missing `iam.serviceAccounts.actAs` on an account nobody named. So this is
   * rendered when the Target supplies one and omitted when it does not, rather
   * than defaulted here — an adapter that invented an identity would be
   * choosing what the workload may reach.
   */
  readonly serviceAccount: string | null;
  /**
   * Whether the Service declares that it uses the project's own admission
   * policy (§16's second verifier).
   *
   * Cloud Run treats Binary Authorization as a property of the Service, not
   * only of the project: a Service that names no policy is a Service with
   * none, which is what the `run.allowedBinaryAuthorizationPolicies`
   * constraint exists to refuse — the vessel's terraform says so in as many
   * words, "so a deployer cannot opt a service out of verification". So
   * declaring it is how a Deploy submits to the check rather than how it
   * escapes one.
   */
  readonly useProjectAdmissionPolicy: boolean;
}

/**
 * How exposure reaches the runtime (§9).
 *
 * Two mechanisms, because exposure is two questions the runtime answers
 * separately: *who can route to it* is ingress, and *who may invoke it* is IAM.
 * Only `public` relaxes the second, which is what "no non-public mode may have a
 * bypassable origin" means here — the authenticated edge §9 wants on `private`
 * is the runtime's own invoker check, enabled by leaving it on.
 */
export function ingressFor(exposure: Exposure): string {
  return exposure === 'internal' ? INGRESS.internalOnly : INGRESS.all;
}

/** Whether this exposure means anyone at all may invoke the Service (§9). */
export function allowsUnauthenticated(exposure: Exposure): boolean {
  return exposure === 'public';
}

/**
 * One Service document, ready to be applied.
 *
 * The `labels` carry the same three names the Kubernetes adapter puts on its
 * delivery object, and for the same reason: a human reading the project should
 * be able to tell which App and Component a Service belongs to without asking
 * Spindrift. They wear the product's own prefix rather than the well-known
 * Kubernetes keys, because a label key here may hold neither a dot nor a slash
 * — and an unprefixed `app` in somebody's project is a collision waiting for
 * whichever tool gets there second.
 *
 * The Deploy id goes on the **revision template** and never on the Service,
 * mirroring §7's rule that the deploy label goes on the pod template — a value
 * that changes every deploy belongs where changing it is the point.
 */
export function cloudRunService(
  desired: DesiredState,
  context: CloudRunRenderContext,
): Record<string, unknown> {
  const limits = resourceLimits(desired);
  const labels = {
    'spindrift-managed': 'true',
    'spindrift-app': desired.app,
    'spindrift-component': desired.component,
  };

  return {
    labels,
    ingress: ingressFor(desired.exposure),
    ...(context.useProjectAdmissionPolicy
      ? { binaryAuthorization: { useDefault: true } }
      : {}),
    template: {
      labels: { ...labels, 'spindrift-deploy': desired.deploy },
      ...(context.serviceAccount === null
        ? {}
        : { serviceAccount: context.serviceAccount }),
      containers: [
        {
          image: context.image,
          ports: [{ containerPort: CONTAINER_PORT }],
          env: environment(desired.config, context.project),
          ...(limits === null ? {} : { resources: { limits } }),
        },
      ],
    },
  };
}

/**
 * Config as the runtime reads it (§10).
 *
 * **Per key, never per blob**, and every entry is a pinned *reference* rather
 * than a value: core has never read one, so there is nothing here it could
 * inline even if the shape allowed it. The runtime resolves each reference at
 * revision start from the same store of record core wrote to, over its own
 * access path — which is why no credential appears in this document.
 */
function environment(
  config: readonly ConfigEntry[],
  project: string,
): readonly Record<string, unknown>[] {
  return config.map((entry) => ({
    name: entry.name,
    valueSource: {
      secretKeyRef: {
        secret: `projects/${project}/secrets/${entry.secret.key}`,
        version: entry.secret.version,
      },
    },
  }));
}

/**
 * What the revision asks for, or `null` when it asks for nothing.
 *
 * Absent rather than defaulted: the runtime has its own defaults, and a value
 * invented here would be core quietly deciding a workload's size — which is the
 * scheduler §3 says placement is not.
 */
function resourceLimits(desired: DesiredState): Record<string, string> | null {
  const limits: Record<string, string> = {};
  if (desired.requirements.resources.cpu !== undefined) {
    limits.cpu = desired.requirements.resources.cpu;
  }
  if (desired.requirements.resources.memory !== undefined) {
    limits.memory = desired.requirements.resources.memory;
  }
  return Object.keys(limits).length === 0 ? null : limits;
}

/**
 * The IAM policy that matches one exposure state.
 *
 * A whole policy rather than a binding to add, because the verb this is handed
 * to replaces what is there: §9's "transitions fail closed" needs the *removal*
 * of public reach to be as expressible as the grant, and a client that could
 * only add would leave a tightened Component reachable by the binding nobody
 * took away.
 *
 * **A named gap, in the direction that fails closed.** §9 gives `Private` "one
 * admin-configured Private audience per Target", and no Target carries one yet
 * — so a `private` Component gets an empty binding list, which is invokable by
 * nobody rather than by an audience. It is reachable at its address and
 * refuses everyone, which is wrong in the safe direction; the plan already
 * treats the authenticated edge as the largest non-Spindrift dependency (Risk
 * 2), and the audience belongs with it rather than being invented here.
 */
export function invokerPolicy(exposure: Exposure): Record<string, unknown> {
  return {
    policy: {
      bindings: allowsUnauthenticated(exposure)
        ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
        : [],
    },
  };
}

/**
 * The longest name the runtime accepts for a Service — the same ceiling a
 * Kubernetes object name has, which is why both go through one helper.
 */
const SERVICE_ID_LIMIT = 63;

/** One Service per (App, Component), so a re-deploy is a new revision. */
export function serviceId(desired: DesiredState): string {
  return workloadName(desired, SERVICE_ID_LIMIT);
}
