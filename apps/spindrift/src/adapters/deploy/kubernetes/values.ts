/**
 * The App chart's values: renders the app class, and checks an operator's
 * chart-values at save time. One inline blob: Argo has no values ConfigMap.
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

/** Must match the value contract the App chart's `Chart.yaml` declares. */
export const VALUES_CONTRACT = '5';

/** The chart's top-level keys, by who may write them. */
export const VALUE_CLASSES = {
  app: 'spindrift',
  /** Per Target; never rendered into. */
  platform: 'operator',
  /** Our value wins where both write. */
  shared: 'both',
} as const;

export type ValueClass = keyof typeof VALUE_CLASSES;

export interface ValuesIssue {
  /** Dotted path into the values object. */
  readonly path: string;
  readonly message: string;
}

/**
 * Refuses a key in the app class and a key the chart has no class for, since
 * Helm ignores unknown values silently.
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

interface SecretEnvValue {
  /** The variable, and the key inside the materialized Secret. */
  name: string;
  /** The Secret the chart's ExternalSecret materializes the value into. */
  secretName: string;
  /** A pinned version, never latest, so a config change is a new Deploy. */
  remote: { key: string; version: string };
}

/**
 * Keyed by shape so the chart never learns engines. `value` has no credential,
 * `secretName` is in the release namespace, and ESO syncs `remoteSecretName`.
 */
export type DatastoreValue =
  | { name: string; secretName: string; secretKey: string }
  | { name: string; remoteSecretName: string; secretKey: string }
  | { name: string; value: string };

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

export interface ChartValues {
  app: AppValues;
  shared: Record<string, unknown>;
  [key: string]: unknown;
}

/** The chart derives the same name from App and Component. */
export function configSecretName(desired: DesiredState): string {
  return `${desired.app}-${desired.component}`;
}

/** `null` when no address is pullable here; the adapter fails as `INTERNAL`. */
export function imageReference(
  desired: DesiredState,
  reachable: readonly string[] = [],
): string | null {
  return artifactAddress(desired.artifact, reachable);
}

/** `deployId` labels this rollout's pods; drift compares `artifactDigest`. */
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
    // '' renders a suspended CronJob: the chart branches on emptiness.
    schedule: desired.schedule ?? '',
    // Empty keeps the image's entrypoint: the chart's `with` skips `[]`.
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
    // Absent on older pinned documents and on Apps with nothing attached.
    datastores: (desired.datastores ?? []).map((attachment) =>
      datastoreValue(attachment, releaseNamespace),
    ),
  };
}

/** A reference that is not `secret://` is an address, never a credential. */
function datastoreValue(
  attachment: DatastoreAttachment,
  releaseNamespace: string,
): DatastoreValue {
  const SECRET = 'secret://';
  if (!attachment.connection.startsWith(SECRET)) {
    return { name: attachment.name, value: attachment.connection };
  }
  // The first segment is the Secret's namespace. A `secretKeyRef` cannot cross
  // namespaces, so a Secret elsewhere goes through the chart's ExternalSecret.
  const path = attachment.connection.slice(SECRET.length);
  const separator = path.indexOf('/');
  const namespace = path.slice(0, separator);
  const secretName = path.slice(separator + 1);
  // ponytail: every `secret://` reference is read at `uri`, the key
  // CloudNativePG's `<cluster>-app` Secret holds the connection string under.
  return namespace === releaseNamespace
    ? { name: attachment.name, secretName, secretKey: 'uri' }
    : { name: attachment.name, remoteSecretName: secretName, secretKey: 'uri' };
}

/**
 * `shared` merges one level deep and ours wins, so a key such as `resources`
 * is never half one side's and half the other's.
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

function resources(desired: DesiredState): Record<string, unknown> {
  const { cpu, memory } = desired.requirements.resources;
  return {
    requests: {
      ...(cpu === undefined ? {} : { cpu }),
      ...(memory === undefined ? {} : { memory }),
    },
  };
}
