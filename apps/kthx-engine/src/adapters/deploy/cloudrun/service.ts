/**
 * `DesiredState` rendered as one Cloud Run Service document. It carries an
 * image and nothing that could make the runtime build.
 */
import type {
  Auth,
  ConfigEntry,
  DesiredState,
  Reach,
} from '../../../domain/desired-state.ts';
import { workloadName } from '../../../domain/workload-name.ts';

export const INGRESS = {
  all: 'INGRESS_TRAFFIC_ALL',
  internalOnly: 'INGRESS_TRAFFIC_INTERNAL_ONLY',
} as const;

/** The runtime passes it as `PORT`, and every zero-config build reads that. */
export const CONTAINER_PORT = 8080;

export interface CloudRunRenderContext {
  readonly project: string;
  /** Pinned by digest where the artifact has one. */
  readonly image: string;
  /**
   * `null` omits it, and the runtime uses the project's default compute
   * account, refusing the apply without `actAs` on it. Never invented here.
   */
  readonly serviceAccount: string | null;
  /**
   * Binary Authorization is per Service: one naming no policy has none, which
   * the vessel's `run.allowedBinaryAuthorizationPolicies` constraint refuses.
   */
  readonly useProjectAdmissionPolicy: boolean;
}

/** Who can route to it. Who may invoke it is IAM's question. */
export function ingressFor(reach: Reach): string {
  return reach === 'none' ? INGRESS.internalOnly : INGRESS.all;
}

/**
 * Both halves must say so: `auth: none` is also what an unroutable Component
 * says, and that must not open it.
 */
export function allowsUnauthenticated(reach: Reach, auth: Auth): boolean {
  return reach === 'public' && auth === 'none';
}

/**
 * Labels use the product's prefix, since a key here may hold no dot or slash.
 * The Deploy id goes on the revision template, where changing it rolls one.
 */
export function cloudRunService(
  desired: DesiredState,
  context: CloudRunRenderContext,
): Record<string, unknown> {
  const labels = workloadLabels(desired);

  return {
    labels,
    ingress: ingressFor(desired.reach),
    // Public, unauthenticated reach is this field, since org policy refuses an
    // `allUsers` binding; `run.managed.requireInvokerIam` must allow it. Always
    // written, so tightening flips it in the PATCH that rolls the template.
    invokerIamDisabled: allowsUnauthenticated(desired.reach, desired.auth),
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
          // Only a Service is contacted.
          ports: [{ containerPort: CONTAINER_PORT }],
        },
      ],
    },
  };
}

export function workloadLabels(desired: DesiredState): Record<string, string> {
  return {
    'spindrift-managed': 'true',
    'spindrift-app': desired.app,
    'spindrift-component': desired.component,
  };
}

/** The container the Service and the Job share; a Service adds `ports`. */
export function workloadContainer(
  desired: DesiredState,
  context: CloudRunRenderContext,
): Record<string, unknown> {
  const limits = resourceLimits(desired);
  return {
    image: context.image,
    // Honoured as in a pod spec. Absent, never empty: the runtime reads an
    // empty list as an override to run no command.
    ...(desired.command === undefined ? {} : { command: [...desired.command] }),
    ...(desired.args === undefined ? {} : { args: [...desired.args] }),
    env: environment(desired.config, context.project),
    ...(limits === null ? {} : { resources: { limits } }),
  };
}

/**
 * One pinned secret reference per key, resolved by the runtime at revision
 * start. Core never holds a value.
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

/** `null` when nothing is asked for: the runtime's defaults apply, not core's. */
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
 * A policy with no bindings is already true of a resource that does not
 * exist, so a 404 writing one is no failure.
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
 * Nobody may invoke through IAM. A whole policy, since `:setIamPolicy` replaces
 * what is there. A `private` Component is invokable by nobody, since no Target
 * names a Private audience yet.
 */
export const CLOSED_INVOKER_POLICY: InvokerPolicy = {
  policy: { bindings: [] },
};

/** One DNS label, the runtime's limit for a Service or Job name. */
const WORKLOAD_ID_LIMIT = 63;

/**
 * One resource per App and Component, so a re-deploy is a new revision. The
 * collection is in the ref, so a Job and a Service may share a name.
 */
export function workloadId(desired: DesiredState): string {
  return workloadName(desired, WORKLOAD_ID_LIMIT);
}
