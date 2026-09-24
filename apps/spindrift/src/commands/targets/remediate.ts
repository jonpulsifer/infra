/**
 * `openPrerequisiteRemediation`: open a pull request with the Terraform that
 * clears one unmet checklist row. Nothing is marked met until a probe sees it.
 */
import { z } from 'zod';
import { targetAdapterSchema } from '../../config/manifest.schema.ts';
import { PREREQUISITES } from '../../domain/capabilities.ts';
import { remediationFor } from '../../domain/remediation.ts';
import { VESSEL_PREREQUISITES } from '../../domain/vessel.ts';
import { GitHubAccessError } from '../../integrations/github/http.ts';
import {
  AlreadyDeclaredError,
  openRemediationPullRequest,
  remediationTransaction,
} from '../../integrations/github/remediation-pr.ts';
import { type Command, failed, ok } from '../types.ts';
import { remediationSubject } from './remediation.ts';

export const openPrerequisiteRemediationInput = z
  .object({
    vessel: z.string().trim().min(1),
    /** Omitted for a row on the vessel's own checklist. */
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
  /** The file the stanza was written to. */
  readonly path: string;
  readonly createdFile: boolean;
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
    // Composed from the stored row and never from client Terraform, so a
    // browser cannot open a pull request with arbitrary content.
    row,
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
    // The destination's vessel can differ from the vessel the row is on.
    return failed(
      'NOT_DEPLOYABLE',
      `${remediation.destination.vessel} declares no Terraform root, so there is nowhere to open this change — the stanza names what a root would contain, and creating one is not something Spindrift does`,
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
        adapter: input.adapter ?? null,
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
    if (cause instanceof AlreadyDeclaredError) {
      return failed('NOT_DEPLOYABLE', cause.message);
    }
    // An unreachable repository is a refusal, never a thrown 500.
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
