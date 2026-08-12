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
 * Four rules decide what this module will and will not emit:
 *
 * 1. **Only what was observed.** A stanza names the project the probe named and
 *    the service it found switched off. There is no placeholder, no `TODO`, and
 *    no full set of services where one failed — a generated change an operator
 *    has to edit before reading is worse than none, because it looks finished.
 *
 *    The rule reaches further than the fields, and this is the half that is
 *    easy to lose: an unmet row is not on its own an observation. Both
 *    checklists report a row unmet when they could not assess it — a service
 *    switched off stops the one probe that would have answered the other two,
 *    a refused listing establishes nothing about what is in the project — and
 *    they mark those rows {@link AnyPrerequisiteRow.assessed} `false` for this
 *    reader. Generating from one would propose a grant for a call nobody made,
 *    or a bucket nobody established was missing, under a pull request button.
 *    So {@link remediationFor} takes the row rather than its name, and an
 *    unassessed row is answered exactly as a Kubernetes one is: with the
 *    reason there is no change rather than with a change.
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
 * 4. **Never a second writer of one fact.** A root that already declares the
 *    bucket, the enabled service or the binding owns it, and a stanza appended
 *    beside it is drift — which `AGENTS.md` prohibits by name — or, where the
 *    resource address repeats, a root that no longer parses. This module
 *    cannot read that root, so every stanza carries
 *    {@link GeneratedRemediation.declares}: the strings a file that already
 *    owns this fact would contain, which `integrations/github/remediation-pr.ts`
 *    checks the destination for before it writes anything.
 *
 * **Composed at read time, never stored.** The loops store what was observed and
 * derive what it means, and a stanza is the second kind of thing: it moves when
 * a root is declared, when a region is connected, when this generator learns a
 * new resource. A copy written into a checklist row would be a derivation that
 * goes stale with nothing to notice, which is the defect `target-loop.ts`
 * already names.
 *
 * **Literals, not a root's own locals.** A stanza names the project rather than
 * `local.project`, and takes no `depends_on` on a service resource, because a
 * root this generator has never read is a root whose locals and resource
 * addresses it would be guessing at — and a stanza referring to one that is not
 * there does not parse either. Rule 4 is what makes that safe rather than
 * sloppy: where a root does own these facts, no stanza is offered at all, so
 * the only file one is ever appended to is one that has nothing to match its
 * spelling against.
 */
import type { TargetAdapter } from '../config/manifest.schema.ts';
import type { Prerequisite } from './capabilities.ts';
import type { VesselPrerequisite } from './vessel.ts';

/** Any row either checklist can put on a screen. */
export type AnyPrerequisite = Prerequisite | VesselPrerequisite;

/**
 * An unmet row, as this module reads one.
 *
 * The name says which change would clear it; `assessed` says whether anything
 * established it needs clearing. Both checklists carry the second — see
 * `PrerequisiteResult.assessed` — and a caller that passed only the name would
 * be handing this generator a row nobody looked at.
 */
export interface AnyPrerequisiteRow {
  readonly name: AnyPrerequisite;
  /** `false` where the probe never got far enough to reach a verdict. */
  readonly assessed?: boolean;
  /**
   * The project the refusal named as the consumer, where that is not the one
   * probed — see `PrerequisiteResult.consumer`.
   *
   * On the row rather than on the subject because it is an observation about
   * one refusal, and the subject is the boundary the probe was aimed at. The
   * two differ exactly when this field is present, which is the whole reason it
   * exists: a stanza generated off the subject would enable a service on a
   * project whose switch was never off.
   */
  readonly consumer?: string;
}

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
  /**
   * The strings a destination that already owns this fact would contain: the
   * resource address this stanza takes, and the value it manages.
   *
   * Written here because this is where the stanza is written and nowhere else
   * knows what it asserts. What it is *for* is one step away: a root that
   * already declares the bucket, enables the service or binds the role does not
   * need this change and must not be given it twice. A repeated resource
   * address does not parse at all, and a second resource managing one fact is
   * drift — the failure `services.tf` in the real root would take, where
   * `google_project_service.service` already holds every API in a `for_each`.
   *
   * Substrings rather than a parse, because this module emits HCL and does not
   * read it, and the one thing a formatted `.tf` file spells predictably is a
   * quoted string.
   */
  readonly declares: readonly string[];
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
  /**
   * Every boundary this installation's declaration puts at a project, so a
   * refusal about a *different* project than the one probed still lands where
   * that project is declared.
   *
   * Needed because {@link RemediationSubject} is one boundary and a
   * `SERVICE_DISABLED` is routinely about another: the consumer the federated
   * token bills, which for this installation's own calls is the home vessel.
   * Resolving it here rather than by convention keeps rule 2 — a project no
   * declaration names has no honest root to put a change in, and inventing one
   * is what this module will not do.
   */
  readonly declared: readonly DeclaredVessel[];
}

/** A boundary the declaration names, as a destination lookup reads one. */
export interface DeclaredVessel {
  readonly name: string;
  /** The project it is; only boundaries that declare one are listed. */
  readonly project: string;
  readonly terraformRoot: string | null;
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
 * The change that clears one unmet row, or the reason there is none.
 *
 * Total over both checklists: every unmet row an operator can see gets an
 * answer here, so the UI never has to decide what an absent remediation meant.
 *
 * The row rather than its name, and the unassessed arm ahead of everything
 * else, because that arm is the one a caller cannot be trusted to remember: a
 * row is unmet either because something was observed wrong or because nothing
 * was observed at all, and only the first is a fault a stanza addresses.
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
 * The one service the probe found switched off — never the full set, and never
 * on a project whose switch was not the one refused.
 *
 * A `SERVICE_DISABLED` names its *consumer*: the project the federated token
 * bills, which for this installation's own calls is the home vessel and not the
 * vessel being probed. Where the two differ, both halves of the change follow
 * the consumer — the stanza's `project` and the root it is filed in — because a
 * change enabling an API on the probed project would clear nothing and would be
 * reviewed by whoever owns a boundary that was never at fault.
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
    // Rule 2, in the one place the destination is not this subject's: a project
    // that appears only in somebody else's refusal is a boundary this
    // declaration has never named, so there is no root to file a change in and
    // no vessel to say one is missing from.
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
    // The service string and not only the address: a root that enables its
    // APIs through one `for_each` resource owns this service under a label
    // nothing here can predict, and appending beside it is two resources
    // managing one enablement.
    declares: [address('google_project_service', label), quote(service)],
    terraform: `resource "google_project_service" "${label}" {
  project            = ${quote(project)}
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
  const label = identifier(`spindrift_${role.slice(role.indexOf('/') + 1)}`);
  return {
    kind: 'generated',
    summary: `Grant ${subject.principal} ${role} on ${subject.project}, which is the role that admits the call this probe was refused.`,
    destination: destinationOf(subject, DESTINATION_FILE.OIDC_FEDERATION),
    // The role string as well, for the reason the service is checked: a root
    // that grants its roles through one `for_each` over a local set already
    // binds this one, and a second `google_project_iam_member` beside it is a
    // second manager of one binding rather than a change that clears anything.
    declares: [address('google_project_iam_member', label), quote(role)],
    terraform: `resource "google_project_iam_member" "${label}" {
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

/** The declared root, or the honest statement that there is not one. */
function destinationOf(
  subject: RemediationSubject,
  file: string,
): RemediationDestination {
  return rootOf(
    { name: subject.vessel, terraformRoot: subject.terraformRoot },
    file,
  );
}

/** The same answer for a boundary that is not the one the row is on. */
function rootOf(
  vessel: Pick<DeclaredVessel, 'name' | 'terraformRoot'>,
  file: string,
): RemediationDestination {
  return vessel.terraformRoot === null
    ? { kind: 'absent', vessel: vessel.name, file }
    : { kind: 'root', path: `${vessel.terraformRoot}/${file}` };
}

/** A Terraform resource name: the label characters HCL admits, and no others. */
function identifier(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

/**
 * A resource address as a formatted `.tf` file spells it — the two quoted
 * labels with the single space `terraform fmt` normalizes to, and without the
 * `resource` keyword, so it matches a `moved` or `import` block naming the same
 * address just as well as the declaration itself.
 */
function address(type: string, label: string): string {
  return `${quote(type)} ${quote(label)}`;
}

/** A quoted HCL string. Closed input, so JSON's escaping is exactly right. */
function quote(value: string): string {
  return JSON.stringify(value);
}
