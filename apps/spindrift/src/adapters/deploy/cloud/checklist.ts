/**
 * §13's checklist, as a cloud Target answers it.
 *
 * The two cloud adapters are assessed against the same three items
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
      `${subject.service} could not be reached: ${probe.message}`,
    );
  }

  const disabled =
    probe.reason === SERVICE_DISABLED || probe.body.includes(SERVICE_DISABLED);
  if (disabled) {
    return checklist({
      PLATFORM_API: {
        met: false,
        assessed: true,
        detail: `the ${subject.service} API is not enabled on ${subject.project}`,
      },
      OIDC_FEDERATION: notAssessed(subject.service),
      VESSEL: notAssessed(subject.service),
    });
  }

  if (probe.status === 401 || probe.status === 403) {
    return checklist({
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
    return checklist({
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

/** Every item unmet, with one sentence — the Target nothing is known about. */
function allUnmet(detail: string): readonly PrerequisiteResult[] {
  return CLOUD_PREREQUISITES.map((name) => ({
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
};

/** Assemble the three in their declared order, so the UI never reorders them. */
function checklist(
  answers: Record<(typeof CLOUD_PREREQUISITES)[number], { met: true } | Unmet>,
): readonly PrerequisiteResult[] {
  return CLOUD_PREREQUISITES.map((name) => ({ name, ...answers[name] }));
}
