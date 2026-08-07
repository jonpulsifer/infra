/**
 * The change that clears an unmet prerequisite, as Terraform (§13, §14).
 *
 * An unmet row used to be a sentence. A sentence is the diagnosis and never the
 * fix, and the fix is always the same shape here: Terraform owns every boundary
 * this installation stands on, so "what would clear this" is a stanza and a path
 * to put it at.
 *
 * **Nothing here mutates anything, and that is the point rather than a
 * limitation.** §14 forbids Spindrift creating a project, enabling an API or
 * minting an identity, and the decisive argument is that it *cannot*: the
 * federated identity that would call the API to create the federation is the
 * thing being created. A connect that mutated would only work after the path it
 * was meant to replace had already been walked. So the product's answer is the
 * change, reviewed and applied by whatever applies Terraform — and the row goes
 * green because the standing loop probed again, not because anything here
 * claimed it.
 *
 * Three rules decide what this module will and will not emit:
 *
 * 1. **Only what was observed.** A stanza names the project the probe named and
 *    the service it found switched off. There is no placeholder, no `TODO`, and
 *    no full set of services where one failed — a generated change an operator
 *    has to edit before reading is worse than none, because it looks finished.
 * 2. **Only where it belongs.** A stanza with no path is a snippet. The
 *    destination is the vessel's own declared Terraform root, and a boundary
 *    that declares none gets {@link RemediationDestination}'s `absent` arm —
 *    "this vessel has no Terraform root, and this is what one would contain" —
 *    rather than an invented directory.
 * 3. **Silence is an answer.** Most rows are cleared by something other than a
 *    Terraform change: a delivery operator is installed into a cluster, a chart
 *    source is an object inside one, a vessel is a project nobody here creates.
 *    Those get {@link NoRemediation} with the reason, which the UI renders
 *    distinctly from a stanza that happens to be empty — the same
 *    found-versus-unavailable split `cloud-discovery.ts` keeps one noun down.
 *
 * **Composed at read time, never stored.** The loops store what was observed and
 * derive what it means, and a stanza is the second kind of thing: it moves when
 * a root is declared, when a region is connected, when this generator learns a
 * new resource. A copy written into a checklist row would be a derivation that
 * goes stale with nothing to notice, which is the defect `target-loop.ts`
 * already names.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { Prerequisite } from './capabilities.ts';
import type { VesselPrerequisite } from './vessel.ts';

/** Any row either checklist can put on a screen. */
export type AnyPrerequisite = Prerequisite | VesselPrerequisite;

/**
 * Where a stanza belongs.
 *
 * Two arms rather than a nullable path, because a boundary that is declared in
 * git and one that is not are different situations with different next moves:
 * the first is a file to append to and a pull request to open, the second is a
 * root somebody has to create first, and there is no honest path to print for
 * it. Inventing `terraform/…/<vessel>/` for the second would be a location
 * nothing in the repository has ever agreed to.
 */
export type RemediationDestination =
  /** Repository-relative path, inside the root this vessel declares. */
  | { readonly kind: 'root'; readonly path: string }
  /** No root is declared; `file` is what one would have to contain. */
  | { readonly kind: 'absent'; readonly vessel: string; readonly file: string };

/** The Terraform that clears one row, and where it goes. */
export interface GeneratedRemediation {
  readonly kind: 'generated';
  /** One sentence naming what applying this changes. */
  readonly summary: string;
  readonly destination: RemediationDestination;
  /** The stanza, exactly as it would be committed. */
  readonly terraform: string;
}

/** Why this row has no generated change — never rendered as an empty box. */
export interface NoRemediation {
  readonly kind: 'none';
  readonly reason: string;
}

export type Remediation = GeneratedRemediation | NoRemediation;

/**
 * Everything a generator may read, and nothing it may guess.
 *
 * Every member is nullable where the fact can genuinely be missing, and a
 * missing fact produces {@link NoRemediation} rather than a stanza with a hole
 * in it. The caller assembles this from the vessel row, the surfaces on it and
 * the manifest — see `commands/targets/remediation.ts`, which is the one place
 * that join is written.
 */
export interface RemediationSubject {
  /** The boundary the unmet row belongs to. */
  readonly vessel: string;
  /** Its project, or `null` where the row states no location yet. */
  readonly project: string | null;
  /** Where this boundary is declared in the infrastructure repository. */
  readonly terraformRoot: string | null;
  /** The runtime surface the row is about; `null` for a boundary's own row. */
  readonly adapter: TargetAdapter | null;
  /**
   * The identity a grant would name, as Terraform spells a member.
   *
   * `null` unless this installation's federation impersonates a service
   * account, which is the one arrangement where the exact principal is a fact
   * Spindrift holds. Federating directly, the subject a grant must name is
   * whatever the pool provider's attribute mapping produces — a value that
   * lives in the provider and not in anything this process reads, so the honest
   * answer is no stanza rather than a member somebody has to correct.
   */
  readonly principal: string | null;
  /** A location observed on this boundary, from a surface that names one. */
  readonly region: string | null;
  /** The bucket this installation stages sources into, when it holds one. */
  readonly sourceBucket: string | null;
}

/**
 * The service each cloud surface is, in the terms `google_project_service`
 * takes.
 *
 * `PLATFORM_API` is only ever asked of these two (`PREREQUISITES_BY_ADAPTER`),
 * so a surface outside this table has no service to name and gets no stanza.
 */
const PLATFORM_SERVICE = {
  cloudrun: 'run.googleapis.com',
  static: 'firebasehosting.googleapis.com',
} as const satisfies Partial<Record<TargetAdapter, string>>;

/**
 * The role that admits the call each surface's probe made.
 *
 * The narrowest predefined role covering what the adapter drives, which is what
 * makes the generated grant reviewable: a wider one would be a change whose
 * blast radius has to be argued about before it can be merged, and a reviewer
 * asked to widen it has more to go on than a reviewer asked to narrow it.
 */
const PLATFORM_ROLE = {
  cloudrun: 'roles/run.admin',
  static: 'roles/firebasehosting.admin',
} as const satisfies Partial<Record<TargetAdapter, string>>;

/** Which file in a root each generated change belongs in. */
const DESTINATION_FILE = {
  PLATFORM_API: 'services.tf',
  OIDC_FEDERATION: 'iam.tf',
  SOURCE_BUCKET: 'storage.tf',
} as const satisfies Partial<Record<AnyPrerequisite, string>>;

/**
 * Rows cleared by something that is not a Terraform change, with the reason.
 *
 * Written as sentences rather than a category, because "no generated
 * remediation" on its own is the empty box this exists to avoid: what an
 * operator needs is which tree the fix lives in, or which fact nobody observed.
 */
const NOT_TERRAFORM: Partial<Record<AnyPrerequisite, string>> = {
  DELIVERY_OPERATOR:
    'a delivery operator is installed into the cluster itself, which is the GitOps tree rather than Terraform',
  CHART_SOURCE:
    'a chart source is an object inside the cluster, created by whatever reconciles that cluster rather than by Terraform',
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
 * The change that clears one unmet row, or the reason there is none.
 *
 * Total over both checklists: every unmet row an operator can see gets an
 * answer here, so the UI never has to decide what an absent remediation meant.
 */
export function remediationFor(
  name: AnyPrerequisite,
  subject: RemediationSubject,
): Remediation {
  const stated = NOT_TERRAFORM[name];
  if (stated !== undefined) return { kind: 'none', reason: stated };

  switch (name) {
    case 'PLATFORM_API':
      return enablePlatformApi(subject);
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

/** The one service the probe found switched off — never the full set. */
function enablePlatformApi(subject: RemediationSubject): Remediation {
  const service = serviceOf(subject.adapter);
  if (service === null || subject.project === null) {
    return {
      kind: 'none',
      reason:
        'nothing observed which project this row is about, or which service was switched off in it',
    };
  }
  return {
    kind: 'generated',
    summary: `Enable ${service} on ${subject.project}. Only the service this probe found switched off; the rest of the project’s services are untouched.`,
    destination: destinationOf(subject, DESTINATION_FILE.PLATFORM_API),
    terraform: `resource "google_project_service" "${identifier(`spindrift_${service.split('.')[0]}`)}" {
  project            = ${quote(subject.project)}
  service            = ${quote(service)}
  disable_on_destroy = false
}
`,
  };
}

/** The grant that admits the call the probe was refused. */
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
  return {
    kind: 'generated',
    summary: `Grant ${subject.principal} ${role} on ${subject.project}, which is the role that admits the call this probe was refused.`,
    destination: destinationOf(subject, DESTINATION_FILE.OIDC_FEDERATION),
    terraform: `resource "google_project_iam_member" "${identifier(`spindrift_${role.slice(role.indexOf('/') + 1)}`)}" {
  project = ${quote(subject.project)}
  role    = ${quote(role)}
  member  = ${quote(subject.principal)}
}
`,
  };
}

/** The bucket a build stages into before any placement is known (§4). */
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

/** The declared root, or the honest statement that there is not one. */
function destinationOf(
  subject: RemediationSubject,
  file: string,
): RemediationDestination {
  return subject.terraformRoot === null
    ? { kind: 'absent', vessel: subject.vessel, file }
    : { kind: 'root', path: `${subject.terraformRoot}/${file}` };
}

/** A Terraform resource name: the label characters HCL admits, and no others. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** A quoted HCL string. Closed input, so JSON's escaping is exactly right. */
function quote(value: string): string {
  return JSON.stringify(value);
}
