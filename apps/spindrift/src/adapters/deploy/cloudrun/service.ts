/**
 * `DesiredState` rendered as one Cloud Run Service (§6).
 *
 * §6 settles the direction of the seam: **core describes, the adapter renders.**
 * This file is the rendering, kept apart from the adapter that applies it: a
 * pure function returning a plain object is a document a test can assert on
 * exactly, without a fake API standing by to catch it.
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
  Auth,
  ConfigEntry,
  DesiredState,
  Reach,
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
 * Where a Component can be reached from, as the runtime's ingress (§9).
 *
 * The runtime answered reach and auth separately long before core split them:
 * *who can route to it* is ingress, and *who may invoke it* is IAM. This is the
 * first half, and it now reads off the field that means it.
 */
export function ingressFor(reach: Reach): string {
  return reach === 'none' ? INGRESS.internalOnly : INGRESS.all;
}

/**
 * Whether anyone at all may invoke the Service (§9).
 *
 * Both halves have to say so. `auth: none` alone is not enough, because it is
 * also what a Component with no route says, and binding `allUsers` on the
 * strength of that would open the invoker check on the one Component that asked
 * to be unroutable. Only a deliberately public and deliberately unauthenticated
 * Component relaxes it; every other cell keeps the runtime's own invoker check,
 * which is the authenticated edge §9 wants and the reason no non-public cell has
 * a bypassable origin here.
 */
export function allowsUnauthenticated(reach: Reach, auth: Auth): boolean {
  return reach === 'public' && auth === 'none';
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
  const labels = workloadLabels(desired);

  return {
    labels,
    ingress: ingressFor(desired.reach),
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
          ...workloadContainer(desired, context),
          // A Service is contacted; a Job is not. This is the one member of the
          // container that belongs to only one of the two documents, which is
          // why it is added here rather than being made optional above.
          ports: [{ containerPort: CONTAINER_PORT }],
        },
      ],
    },
  };
}

/**
 * The three names on every workload this adapter places.
 *
 * The same three the Kubernetes adapter puts on its delivery object, and shared
 * between the two documents this file's neighbour and this one render — a
 * second copy would be two answers to "which App is this" that could drift.
 */
export function workloadLabels(desired: DesiredState): Record<string, string> {
  return {
    'spindrift-managed': 'true',
    'spindrift-app': desired.app,
    'spindrift-component': desired.component,
  };
}

/**
 * The container both documents carry, with nothing either one adds.
 *
 * §4's "build is always separate from deploy" lives here as much as in the
 * documents: an image, a pinned reference per config key, and a size — nothing
 * that could cause the runtime to build. Shared rather than written twice
 * because a Job's container and a Service's container are the same container,
 * and the one difference between them (`ports`) is the caller's to add.
 */
export function workloadContainer(
  desired: DesiredState,
  context: CloudRunRenderContext,
): Record<string, unknown> {
  const limits = resourceLimits(desired);
  return {
    image: context.image,
    env: environment(desired.config, context.project),
    ...(limits === null ? {} : { resources: { limits } }),
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
 * A whole IAM policy, as `:setIamPolicy` takes one.
 *
 * Typed rather than `Record<string, unknown>` because one property of it is
 * load-bearing at the call site: a policy with **no** bindings asserts nothing
 * about a resource that is not there, so writing one at a resource that does
 * not exist is already true and its `404` is not a failure. That rule reads as
 * arbitrary against an opaque blob and obvious against this.
 */
export interface InvokerPolicy {
  readonly policy: {
    readonly bindings: readonly {
      readonly role: string;
      readonly members: readonly string[];
    }[];
  };
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
export function invokerPolicy(reach: Reach, auth: Auth): InvokerPolicy {
  return {
    policy: {
      bindings: allowsUnauthenticated(reach, auth)
        ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
        : [],
    },
  };
}

/**
 * The longest name the runtime accepts for a Service or a Job — the same
 * ceiling a Kubernetes object name has, which is why both go through one
 * helper.
 */
const WORKLOAD_ID_LIMIT = 63;

/**
 * One resource per (App, Component), so a re-deploy is a new revision of the
 * same Service, or the same Job with a new template.
 *
 * The kind is not part of the name: the collection is part of the ref, so
 * `jobs/{id}` and `services/{id}` name two resources rather than collide.
 */
export function workloadId(desired: DesiredState): string {
  return workloadName(desired, WORKLOAD_ID_LIMIT);
}
