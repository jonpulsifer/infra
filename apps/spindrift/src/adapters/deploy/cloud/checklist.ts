/**
 * §13's checklist, as a cloud Target answers it — in the two shapes a cloud
 * control plane refuses in.
 *
 * {@link cloudChecklist} is the federated one, below; {@link tokenChecklist} is
 * the same table asked of a bearer, and they are in one file because they are
 * one decision made twice. Both fold **one probe** into three items, both read
 * the shape of the refusal rather than a body, and both answer in §13's closed
 * vocabulary. What separates them is only which middle item there is to check —
 * `OIDC_FEDERATION` where an identity is exchanged, `API_TOKEN` where the
 * platform federates nothing and a configured credential is the whole story.
 *
 * The federated adapters are assessed against the same three items
 * (`PREREQUISITES_BY_ADAPTER`), and both learn all three from **one call**: the
 * list of what already exists in the project. That is deliberate. Three separate
 * probes would be three chances to be rate-limited, three latencies on a loop
 * that runs on a schedule, and — worse — three answers that can disagree, so
 * that a Target reads authorized against a project that does not exist.
 *
 * What separates the three items is the *shape of the refusal*, which is the
 * one thing a cloud API is reliably precise about:
 *
 * | The probe said | Unmet | Because |
 * | --- | --- | --- |
 * | `200` | — | it exists, the service is on, and this identity may read it |
 * | `403` + `SERVICE_DISABLED` | `PLATFORM_API` | the service is off in this project |
 * | `401`/`403` | `OIDC_FEDERATION` | the federated identity may not act here |
 * | `404` | `VESSEL` | there is no such project or location |
 * | anything else | all three | nothing was established, and saying so beats guessing |
 *
 * **An item that could not be assessed is reported unmet**, with a detail saying
 * so rather than asserting a fault it did not observe. §13 makes an unmet item a
 * non-candidate with a stated reason, and "not assessed" is a stated reason —
 * whereas reporting it met would be core deciding that what it failed to check
 * was fine.
 *
 * That row also carries `assessed: false`, which is the same distinction in a
 * field rather than in a sentence. The detail is written for an operator and a
 * reader downstream must not have to parse it: `remediation.ts` generates the
 * Terraform that clears an observed fault, and a row from either arm below
 * would otherwise be handed a change for something nothing here checked.
 *
 * That same probe answers a second question — {@link cloudSurfaceProbe} — which
 * is whether this project carries the runtime at all. It is separate from the
 * checklist because it decides something the checklist never did: whether there
 * is a Target here to keep a checklist about.
 */
import type {
  Prerequisite,
  PrerequisiteResult,
} from '../../../domain/capabilities.ts';
import type { SurfaceProbe } from '../../../domain/vessel.ts';
import type { CloudResponse } from './http.ts';

/** The three items a cloud Target is assessed against, in display order. */
export const CLOUD_PREREQUISITES = [
  'PLATFORM_API',
  'OIDC_FEDERATION',
  'VESSEL',
] as const satisfies readonly Prerequisite[];

/** What the probe was asking about, in the sentences an operator reads. */
export interface CloudChecklistSubject {
  /** The project this vessel is, in the boundary's own terms (§14). */
  readonly project: string;
  /** What the service is called where the operator would go to enable it. */
  readonly service: string;
  /** The resource the probe listed, named for the failure sentence. */
  readonly scope: string;
}

/**
 * The reason code a cloud API uses for "this service is not turned on here".
 *
 * Matched as a substring of whatever the error carried rather than only as the
 * parsed `reason`, because the same fact arrives as a `reason` detail on some
 * calls and only inside the message on others — and an operator whose project
 * has the API switched off should not get "you are not authorized", which sends
 * them to fix a permission that is already correct.
 */
const SERVICE_DISABLED = 'SERVICE_DISABLED';

/** Fold one probe into §13's three cloud items. */
export function cloudChecklist(
  probe: CloudResponse<unknown>,
  subject: CloudChecklistSubject,
): readonly PrerequisiteResult[] {
  if (probe.ok) return CLOUD_PREREQUISITES.map((name) => ({ name, met: true }));

  if (probe.kind === 'transport') {
    return allUnmet(
      CLOUD_PREREQUISITES,
      `${subject.service} could not be reached: ${probe.message}`,
    );
  }

  const disabled =
    probe.reason === SERVICE_DISABLED || probe.body.includes(SERVICE_DISABLED);
  if (disabled) {
    const consumer =
      probe.consumer !== null && probe.consumer !== subject.project
        ? probe.consumer
        : undefined;
    return checklist(CLOUD_PREREQUISITES, {
      PLATFORM_API: {
        met: false,
        assessed: true,
        detail: `the ${subject.service} API is not enabled on ${disabledProject(probe.consumer, subject)}`,
        // The same fact the sentence carries, in a field: `remediation.ts`
        // decides which project a stanza enables the service on, and reading it
        // back out of the sentence would be parsing prose written for a person.
        ...(consumer === undefined ? {} : { consumer }),
      },
      OIDC_FEDERATION: notAssessed(subject.service),
      VESSEL: notAssessed(subject.service),
    });
  }

  if (probe.status === 401 || probe.status === 403) {
    return checklist(CLOUD_PREREQUISITES, {
      PLATFORM_API: { met: true },
      OIDC_FEDERATION: {
        met: false,
        assessed: true,
        detail: `the federated identity may not act on ${subject.scope}: ${probe.message}`,
      },
      // Not assessed rather than met: a project that refuses to answer has not
      // told us it exists, and a refusal is exactly what a project that is not
      // there looks like from outside.
      VESSEL: notAssessed(subject.service),
    });
  }

  if (probe.status === 404) {
    return checklist(CLOUD_PREREQUISITES, {
      // It answered, which is more than a disabled service does.
      PLATFORM_API: { met: true },
      OIDC_FEDERATION: notAssessed(subject.service),
      VESSEL: {
        met: false,
        assessed: true,
        detail: `${subject.scope} does not exist, and Spindrift never creates a vessel (§14)`,
      },
    });
  }

  return allUnmet(
    CLOUD_PREREQUISITES,
    `${subject.service} answered ${probe.status}: ${probe.message}`,
  );
}

/**
 * Whether that same probe established the project carries this runtime.
 *
 * One question off the call the checklist already made, because the answer is
 * in the same refusal. A cloud runtime is a service that is switched on per
 * project, so **the service being off is the surface not being there** — the
 * `cloudrun` Target an operator would otherwise get is a row nothing can ever
 * be placed on, and §14 forbids Spindrift turning the service on to make it
 * true.
 *
 * Every other refusal is `undetermined`, and the `404` is the one worth stating
 * a reason for: a cloud API answers `404` for a project this identity may not
 * see as readily as for one that is not there, so reading it as an absence
 * would delete a Target over a missing IAM grant. It stays a `VESSEL` row on a
 * Target that exists, where the loop re-checks it.
 */
export function cloudSurfaceProbe(
  probe: CloudResponse<unknown>,
  subject: CloudChecklistSubject,
): SurfaceProbe {
  if (probe.ok) return { kind: 'carried' };
  if (probe.kind === 'transport') {
    return {
      kind: 'undetermined',
      detail: `${subject.service} could not be reached: ${probe.message}`,
    };
  }
  if (
    probe.reason === SERVICE_DISABLED ||
    probe.body.includes(SERVICE_DISABLED)
  ) {
    // Only when the switch that is off is this project's. A refusal whose
    // ErrorInfo names a *different* consumer — the federated token's own
    // project — establishes nothing about what this vessel carries, and
    // reading it as an absence would delete a Target over the installation's
    // own misconfiguration.
    if (probe.consumer !== null && probe.consumer !== subject.project) {
      return {
        kind: 'undetermined',
        detail: `the ${subject.service} API is not enabled on ${probe.consumer}, the project this installation’s calls bill to — nothing was established about ${subject.project}`,
      };
    }
    return {
      kind: 'absent',
      detail: `the ${subject.service} API is not enabled on ${subject.project}, so it carries no ${subject.service} surface`,
    };
  }
  return {
    kind: 'undetermined',
    detail: `${subject.service} answered ${probe.status}: ${probe.message}`,
  };
}

/** The three items a tokened Target is assessed against, in display order. */
const TOKEN_PREREQUISITES = [
  'PLATFORM_API',
  'API_TOKEN',
  'VESSEL',
] as const satisfies readonly Prerequisite[];

/** What a tokened probe was asking about, in the sentences an operator reads. */
export interface TokenChecklistSubject {
  /** What the product is called where the operator would go to fix a token. */
  readonly service: string;
  /** The boundary the probe named — an account id, a team slug (§14). */
  readonly vessel: string;
  /** What that boundary is called on this platform: `account`, `team`. */
  readonly noun: string;
}

/**
 * §13's checklist, as a Target reached with a configured bearer answers it.
 *
 * The federated table above with its middle question asked of a token instead,
 * for the reason `API_TOKEN` exists at all: a platform that federates no
 * identity has no trust relationship to check, and reading `OIDC_FEDERATION:
 * unmet` there would send an operator to configure one that does not exist on
 * either side.
 *
 * | The probe said | Unmet | Because |
 * | --- | --- | --- |
 * | `200` | — | the API answered, the token may act, and the boundary exists |
 * | `401`/`403` | `API_TOKEN` | the bearer is refused, or is not scoped here |
 * | `404` | `VESSEL` | there is no such boundary |
 * | anything else | all three | nothing was established, and saying so beats guessing |
 */
export function tokenChecklist(
  probe: CloudResponse<unknown>,
  subject: TokenChecklistSubject,
): readonly PrerequisiteResult[] {
  if (probe.ok) return TOKEN_PREREQUISITES.map((name) => ({ name, met: true }));
  if (probe.kind === 'transport') {
    return allUnmet(
      TOKEN_PREREQUISITES,
      `${subject.service} could not be reached: ${probe.message}`,
    );
  }
  if (probe.status === 401 || probe.status === 403) {
    return checklist(TOKEN_PREREQUISITES, {
      // It answered, which is more than an unreachable API does.
      PLATFORM_API: { met: true },
      API_TOKEN: {
        met: false,
        assessed: true,
        detail: `this installation's ${subject.service} token may not act on ${subject.vessel}: ${probe.message}`,
      },
      // Not assessed rather than met: a boundary that refuses to answer has not
      // told us it exists, and a refusal is what an absent one looks like from
      // outside.
      VESSEL: notAssessed(subject.service),
    });
  }
  if (probe.status === 404) {
    return checklist(TOKEN_PREREQUISITES, {
      PLATFORM_API: { met: true },
      API_TOKEN: { met: true },
      VESSEL: {
        met: false,
        assessed: true,
        detail: `the ${subject.noun} ${subject.vessel} does not exist, and Spindrift never creates a vessel (§14)`,
      },
    });
  }
  return allUnmet(
    TOKEN_PREREQUISITES,
    `${subject.service} answered ${probe.status}: ${probe.message}`,
  );
}

/**
 * Whether that same probe established the boundary carries this surface.
 *
 * Never `absent`, and that is the honest answer rather than a gap: neither
 * tokened platform has a per-boundary switch that can be off, so no refusal
 * means "this one does not do deployments". A boundary that answers carries it;
 * one that does not has established nothing, and reading a refusal as an
 * absence would delete a Target over an expired token.
 */
export function tokenSurfaceProbe(
  probe: CloudResponse<unknown>,
  subject: TokenChecklistSubject,
): SurfaceProbe {
  if (probe.ok) return { kind: 'carried' };
  return {
    kind: 'undetermined',
    detail:
      probe.kind === 'transport'
        ? `${subject.service} could not be reached: ${probe.message}`
        : `${subject.service} answered ${probe.status} for ${subject.vessel}: ${probe.message}`,
  };
}

/**
 * The project whose switch the refusal is actually about.
 *
 * GCP refuses a call whose *consumer* — the project the federated token bills
 * — has the service off, whatever project the URL names, and its ErrorInfo
 * names that consumer. Echoing `subject.project` when the two differ sends an
 * operator to the console to verify an API that was never the problem.
 */
function disabledProject(
  consumer: string | null,
  subject: CloudChecklistSubject,
): string {
  if (consumer === null || consumer === subject.project) {
    return subject.project;
  }
  return `${consumer} — the project this installation’s calls bill to, not ${subject.project}`;
}

/** Every item unmet, with one sentence — the Target nothing is known about. */
function allUnmet(
  names: readonly Prerequisite[],
  detail: string,
): readonly PrerequisiteResult[] {
  return names.map((name) => ({
    name,
    met: false,
    assessed: false,
    detail,
  }));
}

function notAssessed(service: string): Unmet {
  return {
    met: false,
    assessed: false,
    detail: `not assessed: the ${service} probe did not get far enough to check this`,
  };
}

/**
 * One unmet answer, and whether the probe got far enough to reach it.
 *
 * `assessed` is required rather than optional here so that adding an arm to the
 * table above is a decision about which kind of unmet it is, made where the
 * refusal is read, rather than a default taken by omission.
 */
type Unmet = {
  readonly met: false;
  readonly assessed: boolean;
  readonly detail: string;
  /** See {@link PrerequisiteResult.consumer}. Only the disabled-service arm. */
  readonly consumer?: string;
};

/** Assemble the three in their declared order, so the UI never reorders them. */
function checklist<Name extends Prerequisite>(
  names: readonly Name[],
  answers: Record<Name, { met: true } | Unmet>,
): readonly PrerequisiteResult[] {
  return names.map((name) => {
    const answer: { met: true } | Unmet = answers[name];
    return { name, ...answer };
  });
}
