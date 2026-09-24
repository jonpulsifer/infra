/**
 * The Terraform change that clears an unmet prerequisite, composed at read time
 * and never applied here. It emits only what a probe observed, into the
 * vessel's declared root, and otherwise says why there is no change.
 * Stanzas use literals and no `depends_on`: the root was never read, so a local
 * or resource they named might not exist.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { Prerequisite } from './capabilities.ts';
import type { VesselPrerequisite } from './vessel.ts';

export type AnyPrerequisite = Prerequisite | VesselPrerequisite;

export interface AnyPrerequisiteRow {
  readonly name: AnyPrerequisite;
  /** `false` where the probe never got far enough to reach a verdict. */
  readonly assessed?: boolean;
  /** The consumer project a refusal named; it can differ from the probed one. */
  readonly consumer?: string;
}

export type RemediationDestination =
  /** Repository-relative path, inside the root this vessel declares. */
  | { readonly kind: 'root'; readonly path: string }
  /** No root is declared; `file` is what one would have to contain. */
  | { readonly kind: 'absent'; readonly vessel: string; readonly file: string };

export interface GeneratedRemediation {
  readonly kind: 'generated';
  readonly summary: string;
  readonly destination: RemediationDestination;
  readonly terraform: string;
  /**
   * Strings a root that already owns this fact would contain: the resource
   * address and the managed value. The PR writer checks for them before appending.
   */
  readonly declares: readonly string[];
}

export interface NoRemediation {
  readonly kind: 'none';
  readonly reason: string;
}

export type Remediation = GeneratedRemediation | NoRemediation;

/**
 * Nullable where a fact can be missing; a missing fact yields
 * {@link NoRemediation}, never a stanza with a hole in it.
 */
export interface RemediationSubject {
  readonly vessel: string;
  /** `null` where the row states no location yet. */
  readonly project: string | null;
  /** `null` when the vessel declares no Terraform root. */
  readonly terraformRoot: string | null;
  /** `null` for a vessel's own row. */
  readonly adapter: TargetAdapter | null;
  /**
   * `null` unless federation impersonates a service account. Otherwise the
   * subject comes from the pool provider's attribute mapping, unreadable here.
   */
  readonly principal: string | null;
  /** `null` when no surface on this vessel names a location. */
  readonly region: string | null;
  readonly sourceBucket: string | null;
  /**
   * Every declared vessel with a project, so a refusal about another project than
   * the one probed is written to that project's root.
   */
  readonly declared: readonly DeclaredVessel[];
}

export interface DeclaredVessel {
  readonly name: string;
  /** Only vessels that declare a project are listed. */
  readonly project: string;
  readonly terraformRoot: string | null;
}

/** The service name per Google surface; any other surface gets no stanza. */
const PLATFORM_SERVICE = {
  cloudrun: 'run.googleapis.com',
  static: 'firebasehosting.googleapis.com',
} as const satisfies Partial<Record<TargetAdapter, string>>;

/** The narrowest predefined role covering what each adapter drives. */
const PLATFORM_ROLE = {
  cloudrun: 'roles/run.admin',
  static: 'roles/firebasehosting.admin',
} as const satisfies Partial<Record<TargetAdapter, string>>;

const DESTINATION_FILE = {
  PLATFORM_API: 'services.tf',
  OIDC_FEDERATION: 'iam.tf',
  SOURCE_BUCKET: 'storage.tf',
} as const satisfies Partial<Record<AnyPrerequisite, string>>;

/** Rows cleared by something other than a Terraform change, with the reason. */
const NOT_TERRAFORM: Partial<Record<AnyPrerequisite, string>> = {
  DELIVERY_OPERATOR:
    'a delivery operator is installed into the cluster itself, which is the GitOps tree rather than Terraform',
  CHART_SOURCE:
    'a chart source is an object inside the cluster or the repository recorded on the Target itself, and Terraform declares neither',
  WRITABLE_STORE:
    'a cluster’s writable store is an object inside the cluster, created by whatever reconciles that cluster rather than by Terraform',
  CHART_CONTRACT:
    'chart compatibility is a property of the chart version this Target pins, not of any resource Terraform declares',
  VESSEL:
    'the boundary itself is missing, and Spindrift never creates a vessel (§14) — nor generates the change that would',
  SECRET_STORE:
    'a refused store read does not separate an unreachable endpoint from a missing grant, so no single resource can be named as the one that clears it',
  SIGNER_KEY:
    'a signing key’s algorithm was never observed here, and a key created under the wrong one cannot be changed afterwards',
  ARTIFACTS_PROJECT:
    'a project is what this row is missing, and Spindrift never creates one (§14)',
};

/**
 * Answers every row either checklist shows. An unassessed row gets no change:
 * nothing observed it failing.
 */
export function remediationFor(
  row: AnyPrerequisiteRow,
  subject: RemediationSubject,
): Remediation {
  const name = row.name;
  if (row.assessed === false) {
    return {
      kind: 'none',
      reason: `nothing here observed ${name} failing — the probe stopped before it could assess this row, and a change generated from an observation nobody made is a guess with a pull request beside it`,
    };
  }

  const stated = NOT_TERRAFORM[name];
  if (stated !== undefined) return { kind: 'none', reason: stated };

  switch (name) {
    case 'PLATFORM_API':
      return enablePlatformApi(row, subject);
    case 'OIDC_FEDERATION':
      return grantFederatedAccess(subject);
    case 'SOURCE_BUCKET':
      return declareSourceBucket(subject);
    default:
      return {
        kind: 'none',
        reason: `nothing here knows what change would clear ${name}`,
      };
  }
}

/**
 * Enables only the one service found off. A `SERVICE_DISABLED` names the
 * consumer project it bills, so the stanza and its root follow the consumer.
 */
function enablePlatformApi(
  row: AnyPrerequisiteRow,
  subject: RemediationSubject,
): Remediation {
  const service = serviceOf(subject.adapter);
  if (service === null || subject.project === null) {
    return {
      kind: 'none',
      reason:
        'nothing observed which project this row is about, or which service was switched off in it',
    };
  }
  const consumer =
    row.consumer === undefined || row.consumer === subject.project
      ? null
      : row.consumer;
  const owner =
    consumer === null
      ? null
      : (subject.declared.find((vessel) => vessel.project === consumer) ??
        null);
  if (consumer !== null && owner === null) {
    // An undeclared consumer has no root to file a change in.
    return {
      kind: 'none',
      reason: `the ${service} switch this refusal is about is ${consumer}’s — the project this installation’s calls bill to, not ${subject.project} — and nothing in this declaration names ${consumer} as a vessel, so there is no root to put the change in`,
    };
  }
  const project = consumer ?? subject.project;
  const label = identifier(`spindrift_${service.split('.')[0]}`);
  return {
    kind: 'generated',
    summary:
      owner === null
        ? `Enable ${service} on ${project}. Only the service this probe found switched off; the rest of the project’s services are untouched.`
        : `Enable ${service} on ${project} — the project this installation’s calls bill to, not ${subject.project}, which the refusal establishes nothing about. Only the service this probe found switched off; the rest of the project’s services are untouched.`,
    destination:
      owner === null
        ? destinationOf(subject, DESTINATION_FILE.PLATFORM_API)
        : rootOf(owner, DESTINATION_FILE.PLATFORM_API),
    // The service string too: a root that enables APIs through one `for_each`
    // owns this service under a label nothing here can predict.
    declares: [address('google_project_service', label), quote(service)],
    terraform: `resource "google_project_service" "${label}" {
  project            = ${quote(project)}
  service            = ${quote(service)}
  disable_on_destroy = false
}
`,
  };
}

function grantFederatedAccess(subject: RemediationSubject): Remediation {
  const role = roleOf(subject.adapter);
  if (role === null || subject.project === null) {
    return {
      kind: 'none',
      reason:
        'nothing observed which project this row is about, or which role the refused call needs',
    };
  }
  if (subject.principal === null) {
    return {
      kind: 'none',
      reason:
        'this installation federates without impersonating a service account, so the principal a grant must name is decided by the pool provider’s attribute mapping rather than by anything Spindrift holds',
    };
  }
  const label = identifier(`spindrift_${role.slice(role.indexOf('/') + 1)}`);
  return {
    kind: 'generated',
    summary: `Grant ${subject.principal} ${role} on ${subject.project}, which is the role that admits the call this probe was refused.`,
    destination: destinationOf(subject, DESTINATION_FILE.OIDC_FEDERATION),
    // The role string too, for a root that binds roles through one `for_each`.
    declares: [address('google_project_iam_member', label), quote(role)],
    terraform: `resource "google_project_iam_member" "${label}" {
  project = ${quote(subject.project)}
  role    = ${quote(role)}
  member  = ${quote(subject.principal)}
}
`,
  };
}

function declareSourceBucket(subject: RemediationSubject): Remediation {
  if (subject.project === null || subject.sourceBucket === null) {
    return {
      kind: 'none',
      reason:
        'nothing observed which project this boundary is, or which bucket this installation stages sources into',
    };
  }
  if (subject.region === null) {
    return {
      kind: 'none',
      reason:
        'no surface on this boundary names a location, so where the bucket would live was never observed — and a bucket’s location cannot be changed after it is created',
    };
  }
  return {
    kind: 'generated',
    summary: `Declare ${subject.sourceBucket} in ${subject.project}, at the location this boundary’s connected surface names.`,
    destination: destinationOf(subject, DESTINATION_FILE.SOURCE_BUCKET),
    declares: [
      address('google_storage_bucket', 'spindrift_source'),
      quote(subject.sourceBucket),
    ],
    terraform: `resource "google_storage_bucket" "spindrift_source" {
  project                     = ${quote(subject.project)}
  name                        = ${quote(subject.sourceBucket)}
  location                    = ${quote(subject.region)}
  force_destroy               = false
  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }
}
`,
  };
}

function serviceOf(adapter: TargetAdapter | null): string | null {
  if (adapter === null) return null;
  return adapter in PLATFORM_SERVICE
    ? PLATFORM_SERVICE[adapter as keyof typeof PLATFORM_SERVICE]
    : null;
}

function roleOf(adapter: TargetAdapter | null): string | null {
  if (adapter === null) return null;
  return adapter in PLATFORM_ROLE
    ? PLATFORM_ROLE[adapter as keyof typeof PLATFORM_ROLE]
    : null;
}

function destinationOf(
  subject: RemediationSubject,
  file: string,
): RemediationDestination {
  return rootOf(
    { name: subject.vessel, terraformRoot: subject.terraformRoot },
    file,
  );
}

function rootOf(
  vessel: Pick<DeclaredVessel, 'name' | 'terraformRoot'>,
  file: string,
): RemediationDestination {
  return vessel.terraformRoot === null
    ? { kind: 'absent', vessel: vessel.name, file }
    : { kind: 'root', path: `${vessel.terraformRoot}/${file}` };
}

/** Only the characters HCL admits in a resource label. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * Spelled as `terraform fmt` writes it, without the `resource` keyword, so it
 * also matches a `moved` or `import` block for the same address.
 */
function address(type: string, label: string): string {
  return `${quote(type)} ${quote(label)}`;
}

/** A quoted HCL string. The input is closed, so JSON escaping is valid HCL. */
function quote(value: string): string {
  return JSON.stringify(value);
}
