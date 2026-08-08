/**
 * The facts a remediation is generated from, joined in one place.
 *
 * `domain/remediation.ts` is pure and reads nothing; this is what hands it the
 * world. Two callers need exactly the same join — the Targets screen, which
 * renders a stanza per unmet row, and the act that opens it as a pull request,
 * which must compose the same stanza again rather than trust one that arrived
 * from a browser. A second copy of this join would be a screen and a pull
 * request that can disagree about what a change is.
 *
 * **Composed on every read.** Nothing here is written to a checklist row: what
 * clears a prerequisite moves when a root is declared, when a surface is
 * connected, and when the generator learns a resource, and a stored answer
 * would go stale with nothing watching. The loops keep their rule — store what
 * was observed, derive what it means.
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

/** One surface's connection, as far as a remediation reads it. */
export interface SurfaceFacts {
  readonly connection: {
    readonly adapter: TargetAdapter;
    readonly region?: string;
  } | null;
}

/** The boundary an unmet row belongs to, as the join reads it. */
export interface BoundaryFacts {
  readonly name: string;
  readonly location: VesselLocation | null;
  /** Every Target registered on this boundary, whatever its surface. */
  readonly surfaces: readonly SurfaceFacts[];
}

/**
 * The identity a generated grant would name, or `null` when nothing observed
 * one.
 *
 * Read off the credential this deployment mounts, which is the only copy of
 * this fact that cannot disagree with the pod holding it — the same argument
 * `config/federation-credential.ts` makes for reading the whole federation
 * there rather than asking the manifest for it a second time.
 *
 * Only the impersonation arm answers. Federating directly, the member a policy
 * must name is whatever the pool provider's attribute mapping produces from the
 * projected token's subject, and that mapping lives in the provider — so a
 * principal composed here would be this software guessing at somebody else's
 * configuration and writing the guess into a pull request.
 */
export function federatedPrincipal(
  manifest: InstallationManifest,
): string | null {
  const url = manifest.cloud.federation?.impersonationUrl;
  if (!url) return null;
  const account = /\/serviceAccounts\/([^/:]+)/.exec(url);
  return account === null ? null : `serviceAccount:${account[1]}`;
}

/** Where a resource on this boundary would live, from a surface that says. */
function observedRegion(boundary: BoundaryFacts): string | null {
  for (const surface of boundary.surfaces) {
    const region = surface.connection?.region;
    if (region !== undefined && region !== '') return region;
  }
  return null;
}

/**
 * Everything a generator may read about one unmet row.
 *
 * `adapter` is the surface the row is on, and `null` for a row that belongs to
 * the boundary itself — the two checklists are different questions about the
 * same place, and collapsing them would let a vessel row be answered with a
 * Cloud Run service name.
 */
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
    // Only the boundary that holds it. Every other vessel is asked nothing
    // about a source bucket, so naming one here would be a stanza declaring
    // this installation's bucket in somebody else's project.
    sourceBucket: isHome ? sharedServicesOf(manifest).sourceBucket : null,
    declared: declaredProjects(manifest),
  };
}

/**
 * Every declared boundary that says which project it is.
 *
 * From the document rather than from the vessel rows, for the reason
 * `terraformRootOf` reads the document: a root is a fact about where the
 * declaration lives, and the row it would otherwise be joined to is one this
 * caller does not hold — the refusal names a project, not a boundary.
 *
 * A vessel that declares no location is left out rather than listed with a
 * null: it cannot match a project, and a reader that had to skip it would be
 * the second place this rule is written.
 */
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

/**
 * A checklist row, as this module reads either checklist's.
 *
 * `assessed` travels with the name because `met: false` on its own does not say
 * why, and the two reasons want opposite answers: a fault that was observed has
 * a change that clears it, and a row a probe never reached has nothing to
 * generate from. Passing the row through rather than its name is what keeps
 * that decision inside `remediationFor`, where both callers get it.
 */
interface ChecklistRow {
  readonly name: AnyPrerequisite;
  readonly met: boolean;
  readonly assessed?: boolean;
  /** Travels for the same reason `assessed` does — see `AnyPrerequisiteRow`. */
  readonly consumer?: string;
}

/**
 * Give every unmet row the change that clears it, or the reason there is none.
 *
 * Met rows are left exactly as stored: there is nothing to clear, and a
 * remediation beside a green row would be a change somebody might apply.
 */
export function withRemediations<T extends ChecklistRow>(
  items: readonly T[],
  subject: RemediationSubject,
): readonly (T & { readonly remediation?: Remediation })[] {
  return items.map((item) =>
    item.met ? item : { ...item, remediation: remediationFor(item, subject) },
  );
}
