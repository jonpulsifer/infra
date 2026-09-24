/**
 * Prerequisite checklists for cloud Targets, each folded from one probe by the
 * shape of its refusal, so the items cannot disagree. An item the probe never
 * reached is unmet with `assessed: false`, so no fix is generated for it.
 */
import type {
  Prerequisite,
  PrerequisiteResult,
} from '../../../domain/capabilities.ts';
import type { SurfaceProbe } from '../../../domain/vessel.ts';
import type { CloudResponse } from './http.ts';

/** In display order. */
export const CLOUD_PREREQUISITES = [
  'PLATFORM_API',
  'OIDC_FEDERATION',
  'VESSEL',
] as const satisfies readonly Prerequisite[];

export interface CloudChecklistSubject {
  readonly project: string;
  /** The service as named where an operator would enable it. */
  readonly service: string;
  /** The resource the probe listed, as the failure sentence names it. */
  readonly scope: string;
}

/**
 * Matched in the body too: some calls carry it as a parsed `reason`, others
 * only inside the message.
 */
const SERVICE_DISABLED = 'SERVICE_DISABLED';

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
        // A field too, so `remediation.ts` never parses the sentence for it.
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
      // Unassessed: a refusal is also what a missing project looks like.
      VESSEL: notAssessed(subject.service),
    });
  }

  if (probe.status === 404) {
    return checklist(CLOUD_PREREQUISITES, {
      // It answered, so the service is on.
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
 * The service switched off on this project is `absent`. Every other refusal is
 * `undetermined`, including a `404`, which a missing IAM grant also produces.
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
    // A different consumer is the federated token's own project, which says
    // nothing about what this vessel carries.
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

/** In display order. */
const TOKEN_PREREQUISITES = [
  'PLATFORM_API',
  'API_TOKEN',
  'VESSEL',
] as const satisfies readonly Prerequisite[];

export interface TokenChecklistSubject {
  /** The product as named where an operator would fix a token. */
  readonly service: string;
  /** The boundary the probe named: an account id or a team slug. */
  readonly vessel: string;
  /** What that boundary is called on this platform: `account`, `team`. */
  readonly noun: string;
}

/**
 * The checklist for a Target reached with a configured bearer. The platform
 * federates nothing, so its middle item is `API_TOKEN`.
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
      // It answered, so the API is reachable.
      PLATFORM_API: { met: true },
      API_TOKEN: {
        met: false,
        assessed: true,
        detail: `this installation's ${subject.service} token may not act on ${subject.vessel}: ${probe.message}`,
      },
      // Unassessed: a refusal is also what a missing boundary looks like.
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
 * Never `absent`: neither tokened platform has a per-boundary switch, so a
 * refusal is `undetermined` and cannot delete a Target over an expired token.
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
 * GCP refuses when the token's billing consumer has the service off, whatever
 * project the URL names, and its ErrorInfo names that consumer.
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

/** Every item unmet and unassessed, with one sentence. */
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

/** `assessed` is required, so each arm decides which kind of unmet it is. */
type Unmet = {
  readonly met: false;
  readonly assessed: boolean;
  readonly detail: string;
  /** See {@link PrerequisiteResult.consumer}. Only the disabled-service arm. */
  readonly consumer?: string;
};

/** Answers in declared order, which is display order. */
function checklist<Name extends Prerequisite>(
  names: readonly Name[],
  answers: Record<Name, { met: true } | Unmet>,
): readonly PrerequisiteResult[] {
  return names.map((name) => {
    const answer: { met: true } | Unmet = answers[name];
    return { name, ...answer };
  });
}
