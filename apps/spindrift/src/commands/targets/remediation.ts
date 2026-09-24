/**
 * Joins the facts a remediation is generated from. The Targets screen
 * and the pull request act share it, so both compose the same stanza.
 */
import type {
  InstallationManifest,
  TargetAdapter,
} from '../../config/manifest.schema.ts';
import {
  sharedServicesOf,
  terraformRootOf,
} from '../../config/manifest.schema.ts';
import type {
  AnyPrerequisite,
  DeclaredVessel,
  Remediation,
  RemediationSubject,
} from '../../domain/remediation.ts';
import { remediationFor } from '../../domain/remediation.ts';
import type { VesselLocation } from '../../domain/vessel.ts';

export interface SurfaceFacts {
  readonly connection: {
    readonly adapter: TargetAdapter;
    readonly region?: string;
  } | null;
}

export interface BoundaryFacts {
  readonly name: string;
  readonly location: VesselLocation | null;
  readonly surfaces: readonly SurfaceFacts[];
}

/**
 * The impersonated service account a grant should name. `null` without
 * impersonation: a federated member comes from a provider mapping unseen here.
 */
export function federatedPrincipal(
  manifest: InstallationManifest,
): string | null {
  const url = manifest.cloud.federation?.impersonationUrl;
  if (!url) return null;
  const account = /\/serviceAccounts\/([^/:]+)/.exec(url);
  return account === null ? null : `serviceAccount:${account[1]}`;
}

function observedRegion(boundary: BoundaryFacts): string | null {
  for (const surface of boundary.surfaces) {
    const region = surface.connection?.region;
    if (region !== undefined && region !== '') return region;
  }
  return null;
}

/** `adapter` is `null` for a row on the vessel's own checklist. */
export function remediationSubject(
  manifest: InstallationManifest,
  boundary: BoundaryFacts,
  adapter: TargetAdapter | null,
): RemediationSubject {
  const location = boundary.location;
  const isHome = boundary.name === manifest.installation.homeVessel;
  return {
    vessel: boundary.name,
    project:
      location !== null && location.kind === 'gcp-project'
        ? location.project
        : null,
    terraformRoot: terraformRootOf(manifest, boundary.name),
    adapter,
    principal: federatedPrincipal(manifest),
    region: observedRegion(boundary),
    // Only the home vessel holds the source bucket. Another vessel's stanza
    // would declare it in the wrong project.
    sourceBucket: isHome ? sharedServicesOf(manifest).sourceBucket : null,
    declared: declaredProjects(manifest),
  };
}

/** Read from the manifest, where each vessel's Terraform root is declared. */
function declaredProjects(
  manifest: InstallationManifest,
): readonly DeclaredVessel[] {
  return manifest.vessels.flatMap((vessel) =>
    vessel.kind === 'gcp-project' && vessel.location !== undefined
      ? [
          {
            name: vessel.name,
            project: vessel.location.project,
            terraformRoot: vessel.terraformRoot ?? null,
          },
        ]
      : [],
  );
}

/** Passed whole: {@link remediationFor} reads `assessed` and `consumer`. */
interface ChecklistRow {
  readonly name: AnyPrerequisite;
  readonly met: boolean;
  readonly assessed?: boolean;
  readonly consumer?: string;
}

/**
 * Gives each unmet row the change that clears it, or why there is none. Never
 * stored, because the answer moves with the manifest and the generator.
 */
export function withRemediations<T extends ChecklistRow>(
  items: readonly T[],
  subject: RemediationSubject,
): readonly (T & { readonly remediation?: Remediation })[] {
  return items.map((item) =>
    item.met ? item : { ...item, remediation: remediationFor(item, subject) },
  );
}
