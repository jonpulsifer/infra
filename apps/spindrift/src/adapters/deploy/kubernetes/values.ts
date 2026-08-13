/**
 * The App chart's values, and the boundary between who may write which (§7).
 *
 * **Three value classes, not two.** "Some keys are written by both operator and
 * Spindrift, so a disjointness rule would reject a correct config. The boundary
 * is enforced at save time, giving each Target a chart-values field." So this
 * module does two things: it renders Spindrift's class from a
 * {@link DesiredState}, and it is where an operator's chart-values are checked
 * before they are stored on a Target — not when a deploy happens to run, by
 * which point the operator who typed them is gone.
 *
 * **Spindrift writes one inline values blob** (§7). A values ConfigMap is dead
 * as a portable mechanism: Flux merges `valuesFrom` and then overwrites it
 * inline, and Argo has no equivalent at all.
 */
import {
  artifactAddress,
  type DatastoreAttachment,
  type DesiredState,
} from '../../../domain/desired-state.ts';
import {
  appNamespaceFor,
  type KubernetesConnection,
} from '../../../domain/target.ts';

/**
 * The value-contract version this adapter renders for.
 *
 * §7: "The chart declares its own value contract and version, read at pin
 * time. Skew is guaranteed and Helm ignores unknown values silently, so an
 * unrepinned Target would apply cleanly, report green, and run without config."
 * This constant is the other half of that comparison — what the code writing
 * the values believes the contract to be — and `packages/charts/spindrift-app`
 * declares the same number in its own `Chart.yaml`.
 */
export const VALUES_CONTRACT = '5';

/** The three classes §7 names, as the chart's three top-level keys. */
export const VALUE_CLASSES = {
  /** Spindrift writes; an operator may not. */
  app: 'spindrift',
  /** The operator writes, per Target; Spindrift never renders into it. */
  platform: 'operator',
  /** Either may write. Spindrift's value wins where both do. */
  shared: 'both',
} as const;

export type ValueClass = keyof typeof VALUE_CLASSES;

/** One thing wrong with an operator's chart-values, in their own terms. */
export interface ValuesIssue {
  /** Dotted path into the values object. */
  readonly path: string;
  readonly message: string;
}

/**
 * Check an operator's chart-values before they are saved to a Target.
 *
 * Two refusals, and no others: a key in Spindrift's own class, and a key the
 * chart has no class for. The second matters as much as the first — Helm
 * ignores an unknown value silently, so a typo an operator makes here would
 * otherwise be discovered as a workload running without the setting they
 * thought they had applied.
 */
export function operatorValuesIssues(
  values: Record<string, unknown> | undefined,
): readonly ValuesIssue[] {
  if (values === undefined) return [];
  const issues: ValuesIssue[] = [];
  for (const key of Object.keys(values)) {
    if (!Object.hasOwn(VALUE_CLASSES, key)) {
      issues.push({
        path: key,
        message: `the App chart has no ${key} values`,
      });
      continue;
    }
    if (VALUE_CLASSES[key as ValueClass] === 'spindrift') {
      issues.push({
        path: key,
        message: `${key} values are Spindrift's to write, not an operator's`,
      });
    }
  }
  return issues;
}

/** One environment variable, as the chart names a pinned reference (§10). */
interface SecretEnvValue {
  /** The variable, and the key inside the materialized Secret. */
  name: string;
  /** The Secret the platform's own machinery materializes the value into. */
  secretName: string;
  /**
   * The pinned item in the store of record — what the chart's ExternalSecret
   * fetches. Never a value, and never a floating latest: §10's pin is the
   * reason a config change produces a new Deploy rather than silently not
   * applying.
   */
  remote: { key: string; version: string };
}

/**
 * One attached Datastore, as the chart takes it (§11).
 *
 * Told apart by which key is present rather than by an engine field: the chart
 * must not learn the engine vocabulary, and there is nothing it could do with
 * the engine that the shape does not already say.
 *
 * Three shapes, and which one is rendered is decided by where the Datastore
 * actually is rather than by what engine it runs:
 *
 * - `value` — no credential at all. A Valkey as this platform runs it
 *   authenticates nobody, so the reference is an address, and writing an
 *   address into a Secret would make it look like one without making it one.
 * - `secretName` — the operator's Secret is in this release's own namespace, so
 *   a `secretKeyRef` reaches it directly and the credential never transits
 *   Spindrift.
 * - `remoteSecretName` — it is not, because a Datastore lives in a namespace of
 *   its own (§11) and a `secretKeyRef` cannot cross one. The chart renders an
 *   `ExternalSecret` against the store scoped to the datastore namespace, which
 *   is still not a copy Spindrift holds: ESO reconciles it continuously, so the
 *   operator's rotation reaches the next pod on ESO's own interval with no
 *   Deploy.
 */
export type DatastoreValue =
  | { name: string; secretName: string; secretKey: string }
  | { name: string; remoteSecretName: string; secretKey: string }
  | { name: string; value: string };

/** Spindrift's class, rendered from what core described. */
export interface AppValues {
  name: string;
  component: string;
  kind: DesiredState['kind'];
  image: string;
  port: number;
  expose: boolean;
  reach: DesiredState['reach'];
  auth: DesiredState['auth'];
  schedule: string;
  command: string[];
  args: string[];
  deployId: string;
  artifactDigest: string;
  hostnames: string[];
  secretEnv: SecretEnvValue[];
  datastores: DatastoreValue[];
}

/** The whole inline blob one release is applied with. */
export interface ChartValues {
  app: AppValues;
  shared: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * The Secret one Component's config is delivered through.
 *
 * §10 is per-key, not per-blob — one secret *per variable* — which is about how
 * a value is stored and pinned in the store of record, not about how many
 * Kubernetes objects it lands in. The chart's ExternalSecret materializes this
 * Secret from the pinned references; the name is derived on both sides from the
 * App and the Component so neither has to import the other, and it is the same
 * composition `spindrift-app.fullname` makes.
 */
export function configSecretName(desired: DesiredState): string {
  return `${desired.app}-${desired.component}`;
}

/**
 * A pullable address for what was built.
 *
 * §6's `artifact` carries a digest and the addresses it can be pulled by; a
 * Kubernetes Target needs an address, and the digest is what makes it
 * immutable. An artifact with no address is a core bug — the adapter says so as
 * `INTERNAL` rather than rendering a release that cannot pull.
 */
export function imageReference(
  desired: DesiredState,
  reachable: readonly string[] = [],
): string | null {
  return artifactAddress(desired.artifact, reachable);
}

/**
 * Render Spindrift's class from the neutral description (§6).
 *
 * Deploy identity and artifact identity remain separate. The Deploy label lets
 * diagnosis select only the pods created by this rollout (§7); the digest lets
 * core compare what the delivery object still carries with desired state (§6).
 */
export function appValues(
  desired: DesiredState,
  image: string,
  releaseNamespace: string,
): AppValues {
  return {
    name: desired.app,
    component: desired.component,
    kind: desired.kind,
    image,
    // `website` is not a chart branch: normalize it to service values here.
    port: 8080,
    expose:
      desired.kind === 'website' ||
      (desired.kind === 'service' && desired.expose === true),
    reach: desired.reach,
    auth: desired.auth,
    // An absent schedule is a suspended CronJob, which is why this is '' and
    // not omitted: the chart branches on emptiness, not on presence.
    schedule: desired.schedule ?? '',
    // Empty is the image's own entrypoint, which is why these are `[]` and not
    // omitted: the chart's `podSpec` wraps each in `with`, which skips an
    // empty list exactly as it skips an absent key, so a Deployment and a
    // CronJob both fall back to the image. `VALUES_CONTRACT` does not move for
    // these — the chart has declared both keys since it was written, and
    // writing a key the chart already accepts is not a contract change.
    command: [...(desired.command ?? [])],
    args: [...(desired.args ?? [])],
    deployId: desired.deploy,
    artifactDigest: desired.artifact.digest,
    hostnames: [
      desired.hostname.canonical,
      ...(desired.hostname.vanity === undefined
        ? []
        : [desired.hostname.vanity]),
    ],
    secretEnv: desired.config.map((entry) => ({
      name: entry.name,
      secretName: configSecretName(desired),
      remote: { key: entry.secret.key, version: entry.secret.version },
    })),
    // Absent on every document pinned before §11's delivery existed, and on
    // every App with nothing attached.
    datastores: (desired.datastores ?? []).map((attachment) =>
      datastoreValue(attachment, releaseNamespace),
    ),
  };
}

/**
 * A connection reference, as the chart's env entry.
 *
 * **The scheme is parsed here, in the adapter.** Core stores the reference as
 * an opaque string (`adapters/datastore/contract.ts`) precisely so that no
 * backend's naming scheme reaches it, and `uri` — the key CloudNativePG writes
 * the whole connection string under in the `<cluster>-app` Secret it generates
 * — is a Kubernetes fact. It belongs beside the chart that reads it, not in
 * `domain/`, which would then know one operator's Secret layout.
 *
 * Anything that is not a `secret://` reference holds no credential to reference:
 * a Valkey connection is `redis://host:port`, which is an address. Writing it
 * into a Secret would make it look like a secret without making it one.
 */
function datastoreValue(
  attachment: DatastoreAttachment,
  releaseNamespace: string,
): DatastoreValue {
  const SECRET = 'secret://';
  if (!attachment.connection.startsWith(SECRET)) {
    return { name: attachment.name, value: attachment.connection };
  }
  // The `<container>` segment is the namespace, and it is now read rather than
  // dropped — this is what the `ponytail:` ceiling here was waiting for. A
  // Datastore lives in a namespace of its own, so the two disagree in the
  // ordinary case and a `secretKeyRef` cannot cross one. They still agree for
  // every Datastore provisioned before per-App namespaces, whose Secret is
  // beside the release that was placed with it, and that case keeps the direct
  // reference rather than growing an ESO hop it does not need.
  const path = attachment.connection.slice(SECRET.length);
  const separator = path.indexOf('/');
  const namespace = path.slice(0, separator);
  const secretName = path.slice(separator + 1);
  return namespace === releaseNamespace
    ? { name: attachment.name, secretName, secretKey: 'uri' }
    : { name: attachment.name, remoteSecretName: secretName, secretKey: 'uri' };
}

/**
 * The whole blob: the operator's class as saved on the Target, plus
 * Spindrift's, plus the shared keys Spindrift has an opinion about.
 *
 * The merge is one level deep and Spindrift wins, which is the shared class's
 * whole definition. It is not deeper than that on purpose: a recursive merge
 * would let an operator set `shared.resources.limits.cpu` and leave Spindrift's
 * `requests` beside it, and the result would be a value neither of them wrote.
 */
export function chartValues(
  desired: DesiredState,
  connection: KubernetesConnection,
  image: string,
): ChartValues {
  const operator = connection.chartValues ?? {};
  const shared = {
    ...((operator.shared as Record<string, unknown> | undefined) ?? {}),
    ...(hasResources(desired) ? { resources: resources(desired) } : {}),
  };

  return {
    ...operator,
    app: appValues(desired, image, appNamespaceFor(connection, desired.app)),
    shared,
  };
}

function hasResources(desired: DesiredState): boolean {
  const { cpu, memory } = desired.requirements.resources;
  return cpu !== undefined || memory !== undefined;
}

/**
 * What the workload asked for, as the chart takes it.
 *
 * Requests only. §3 keeps core out of scheduling — "resolution is a filter, not
 * a scheduler" — and a limit is the Target's ceiling to set (§8: limits and
 * quotas are per-Target numbers rendered outside the App's release), so the
 * operator's `shared.resources.limits` stands wherever they set one.
 */
function resources(desired: DesiredState): Record<string, unknown> {
  const { cpu, memory } = desired.requirements.resources;
  return {
    requests: {
      ...(cpu === undefined ? {} : { cpu }),
      ...(memory === undefined ? {} : { memory }),
    },
  };
}
