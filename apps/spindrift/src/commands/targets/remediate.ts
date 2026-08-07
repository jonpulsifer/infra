/**
 * `openPrerequisiteRemediation` — one unmet row, opened as a pull request.
 *
 * The act §13's checklist was missing. A red row said what was wrong and left
 * the operator to work out the change; this composes that change and opens it
 * where the boundary is declared.
 *
 * **It writes nothing here.** No row is marked met, no Target is touched, and
 * no vessel is. That is the same rule `connectRepository` keeps for its own
 * configuration pull request, and it is the honest one: an unmerged pull
 * request has changed nothing about the boundary, so a checklist that moved
 * would be stating a fact nobody had established. The row goes green when the
 * standing loop next probes a boundary the change has been applied to.
 *
 * **And it composes the stanza again rather than accepting one.** The browser
 * sends a vessel, a surface and a row name — never Terraform. A command that
 * took a stanza from a client would be a way to open a pull request containing
 * anything at all against the repository that owns every boundary here.
 */
import { z } from 'zod';
import { targetAdapterSchema } from '../../config/manifest.schema.ts';
import { PREREQUISITES } from '../../domain/capabilities.ts';
import { remediationFor } from '../../domain/remediation.ts';
import { VESSEL_PREREQUISITES } from '../../domain/vessel.ts';
import { GitHubAccessError } from '../../integrations/github/http.ts';
import {
  openRemediationPullRequest,
  remediationTransaction,
} from '../../integrations/github/remediation-pr.ts';
import { type Command, failed, ok } from '../types.ts';
import { remediationSubject } from './remediation.ts';

export const openPrerequisiteRemediationInput = z
  .object({
    /** The boundary the row belongs to. */
    vessel: z.string().trim().min(1),
    /**
     * The surface the row is on, omitted for a row that belongs to the
     * boundary itself.
     *
     * The two checklists are different questions about the same place, so this
     * is what says which one is being asked — never a default, because a
     * default would answer a vessel's row with a runtime's.
     */
    adapter: targetAdapterSchema.optional(),
    prerequisite: z.enum([...PREREQUISITES, ...VESSEL_PREREQUISITES]),
  })
  .strict();

export type OpenPrerequisiteRemediationInput = z.infer<
  typeof openPrerequisiteRemediationInput
>;

export interface OpenPrerequisiteRemediationResult {
  readonly pullRequest: number;
  readonly branch: string;
  /** Where the stanza landed, so the answer names the change's home. */
  readonly path: string;
  /** True where the destination file did not exist and this created it. */
  readonly createdFile: boolean;
  /**
   * Always false: nothing about the boundary changed, and the row that sent
   * this stays unmet until the loop observes otherwise (§13).
   */
  readonly prerequisiteMet: false;
}

export const openPrerequisiteRemediation: Command<
  OpenPrerequisiteRemediationInput,
  OpenPrerequisiteRemediationResult
> = async (input, context) => {
  const vessel = await context.db.query.vessels.findFirst({
    where: (vessels, { eq }) => eq(vessels.name, input.vessel),
  });
  if (vessel === undefined) {
    return failed('NOT_FOUND', `no vessel named ${input.vessel} is connected`);
  }

  const onVessel = await context.db.query.targets.findMany({
    with: { vessel: true },
    where: (targets, { eq }) => eq(targets.vesselId, vessel.id),
  });

  const surface =
    input.adapter === undefined
      ? null
      : onVessel.find((row) => row.adapter === input.adapter);
  if (input.adapter !== undefined && surface === undefined) {
    return failed(
      'NOT_FOUND',
      `${input.vessel} carries no ${input.adapter} surface`,
    );
  }

  const checklist = (surface ?? vessel).prerequisites ?? [];
  const row = checklist.find((item) => item.name === input.prerequisite);
  if (row === undefined) {
    return failed(
      'NOT_FOUND',
      `${input.prerequisite} is not on ${input.vessel}'s checklist, so nothing here has been asked about it`,
    );
  }
  if (row.met) {
    return failed(
      'NOT_DEPLOYABLE',
      `${input.prerequisite} is already met on ${input.vessel}, so there is nothing to change`,
    );
  }

  const remediation = remediationFor(
    input.prerequisite,
    remediationSubject(
      context.manifest,
      {
        name: vessel.name,
        location: vessel.location,
        surfaces: onVessel,
      },
      input.adapter ?? null,
    ),
  );
  if (remediation.kind === 'none') {
    return failed(
      'NOT_DEPLOYABLE',
      `no Terraform change was generated for ${input.prerequisite}: ${remediation.reason}`,
    );
  }
  if (remediation.destination.kind !== 'root') {
    return failed(
      'NOT_DEPLOYABLE',
      `${input.vessel} declares no Terraform root, so there is nowhere to open this change — the stanza names what a root would contain, and creating one is not something Spindrift does`,
    );
  }

  const repository = context.manifest.github.infrastructureRepository;
  if (repository === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation names no infrastructure repository, so a remediation can be copied but not opened',
    );
  }

  const host = context.adapters.repository();
  if (host === null || host.installationFor === undefined) {
    return failed(
      'NOT_DEPLOYABLE',
      'this installation has no repository integration that can open a pull request',
    );
  }

  try {
    const ref = await host.installationFor(repository);
    const { defaultBranch } = await host.repository(ref, repository);
    const opened = await openRemediationPullRequest(host, ref, {
      fullName: repository,
      defaultBranch,
      transaction: remediationTransaction({
        vessel: input.vessel,
        prerequisite: input.prerequisite,
        remediation,
      }),
    });
    return ok({
      pullRequest: opened.number,
      branch: opened.branch,
      path: opened.path,
      createdFile: opened.createdFile,
      prerequisiteMet: false,
    });
  } catch (cause) {
    // A repository this installation cannot reach is a fact about the world,
    // reported as a refusal the operator can act on — never an exception the
    // dispatch surface turns into a 500. The same rule §15 keeps for the
    // configuration pull request.
    const detail =
      cause instanceof GitHubAccessError
        ? 'check that the App installation still selects it'
        : cause instanceof Error
          ? cause.message
          : String(cause);
    return failed(
      'NOT_DEPLOYABLE',
      `Spindrift could not open a pull request on ${repository}: ${detail}`,
    );
  }
};
