/**
 * One unmet prerequisite, opened as a pull request that appends a Terraform
 * stanza to a file in the infrastructure repository. It never creates a root,
 * and refuses when the file already declares what the stanza would.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { GeneratedRemediation } from '../../domain/remediation.ts';
import type {
  RepositoryRef,
  RepositoryWriter,
} from '../../domain/repository.ts';

export const REMEDIATION_BRANCH_PREFIX = 'spindrift/remediate';

/**
 * Names the surface, since one vessel can have the same unmet row on two
 * surfaces, and a shared branch would force-push over the first change.
 */
export function remediationBranch(
  vessel: string,
  adapter: TargetAdapter | null,
  prerequisite: string,
): string {
  const row = prerequisite.toLowerCase().replace(/_/g, '-');
  const surface = adapter === null ? '' : `${adapter}-`;
  return `${REMEDIATION_BRANCH_PREFIX}/${vessel}-${surface}${row}`;
}

export interface RemediationTransaction {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Repository-relative. */
  readonly path: string;
  readonly stanza: string;
  /** Facts the destination must not already declare. */
  readonly declares: readonly string[];
}

function subjectOf(vessel: string, adapter: TargetAdapter | null): string {
  return adapter === null ? vessel : `${vessel}’s ${adapter} surface`;
}

function pullRequestBody(input: {
  readonly subject: string;
  readonly prerequisite: string;
  readonly path: string;
  readonly summary: string;
}): string {
  return `Spindrift wrote this. It checks ${input.subject} on a standing loop, found \`${input.prerequisite}\` unmet, and this is the change that clears it.

${input.summary}

Merging this is not what clears the row — applying it is. Once it has been applied, the next pass of that loop observes the boundary again and the row goes green on its own; nothing has to be pressed here afterwards. An unmerged or closed pull request changes nothing at all.

The only file touched is \`${input.path}\`, and the only thing added to it is the stanza below the diff. Spindrift enables no service, creates no identity and mutates no boundary itself — it reads, states what is missing, and opens this.
`;
}

/**
 * Pure: nothing is sent. Throws when the boundary declares no Terraform root,
 * since there is no file to write to.
 */
export function remediationTransaction(input: {
  readonly vessel: string;
  /** `null` for a row that belongs to the boundary itself. */
  readonly adapter: TargetAdapter | null;
  readonly prerequisite: string;
  readonly remediation: GeneratedRemediation;
}): RemediationTransaction {
  const { destination } = input.remediation;
  if (destination.kind !== 'root') {
    throw new RangeError(
      `${input.vessel} declares no Terraform root, so there is nowhere to open this change`,
    );
  }
  const subject = subjectOf(input.vessel, input.adapter);
  return {
    branch: remediationBranch(input.vessel, input.adapter, input.prerequisite),
    title: `${subject}: clear ${input.prerequisite}`,
    body: pullRequestBody({
      subject,
      prerequisite: input.prerequisite,
      path: destination.path,
      summary: input.remediation.summary,
    }),
    commitMessage: `Clear ${input.prerequisite} on ${subject}`,
    path: destination.path,
    stanza: input.remediation.terraform,
    declares: input.remediation.declares,
  };
}

export type RemediationHost = RepositoryWriter & {
  branchHead(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
  ): Promise<string>;
  readFile(
    ref: RepositoryRef,
    fullName: string,
    commit: string,
    path: string,
  ): Promise<string | null>;
};

export interface OpenedRemediationPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
  readonly createdFile: boolean;
}

export class AlreadyDeclaredError extends Error {
  constructor(
    readonly path: string,
    readonly found: string,
  ) {
    super(
      `${path} already declares this change — it names ${found}. A second declaration of one fact is drift rather than a remediation, so nothing was opened; whatever is keeping this row unmet is not a stanza missing from that file.`,
    );
    this.name = 'AlreadyDeclaredError';
  }
}

function appended(existing: string | null, stanza: string): string {
  if (existing === null || existing.trim() === '') return stanza;
  return `${existing.replace(/\n+$/, '')}\n\n${stanza}`;
}

/**
 * A repeated resource address breaks the plan for the whole root, and a
 * repeated value applies as two resources managing one thing.
 */
function alreadyDeclared(
  existing: string | null,
  declares: readonly string[],
): string | null {
  if (existing === null) return null;
  return declares.find((fact) => existing.includes(fact)) ?? null;
}

export async function openRemediationPullRequest(
  host: RemediationHost,
  ref: RepositoryRef,
  input: {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly transaction: RemediationTransaction;
  },
): Promise<OpenedRemediationPullRequest> {
  const { fullName, defaultBranch, transaction } = input;

  const base = await host.branchHead(ref, fullName, defaultBranch);
  const baseTree = await host.commitTree(ref, fullName, base);
  const existing = await host.readFile(ref, fullName, base, transaction.path);

  const owned = alreadyDeclared(existing, transaction.declares);
  if (owned !== null) {
    throw new AlreadyDeclaredError(transaction.path, owned);
  }

  const blob = await host.createBlob(
    ref,
    fullName,
    appended(existing, transaction.stanza),
  );
  const tree = await host.createTree(ref, fullName, baseTree, [
    { path: transaction.path, blob },
  ]);
  const commit = await host.createCommit(ref, fullName, {
    message: transaction.commitMessage,
    tree,
    parent: base,
  });
  await host.setBranch(ref, fullName, transaction.branch, commit);

  const number = await host.openPullRequest(ref, fullName, {
    title: transaction.title,
    body: transaction.body,
    head: transaction.branch,
    base: defaultBranch,
  });

  return {
    number,
    branch: transaction.branch,
    commit,
    path: transaction.path,
    createdFile: existing === null,
  };
}
