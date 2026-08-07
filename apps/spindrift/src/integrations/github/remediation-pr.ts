/**
 * One unmet prerequisite, opened as a pull request against the infrastructure
 * repository.
 *
 * `config-pr.ts` already does this shape one noun over, and the rules its
 * header states transfer without change:
 *
 * - **Nothing here is authoritative.** This module opens a pull request and
 *   returns its number. It writes no checklist row, no Target and no vessel,
 *   and it does not mark anything met — an unmerged pull request changes
 *   nothing about a boundary, and the standing loop is what will notice when a
 *   merged one has been applied.
 * - **One pull request is one prerequisite's change and nothing else.** A
 *   change that also enabled a second service, or tidied the file it landed
 *   in, is a review about something other than the row it came from.
 * - **Human-editable.** The stanza is what an operator would have written, in
 *   the file it belongs in, so the review is about the change rather than about
 *   the tool that produced it.
 *
 * **Appending, not templating.** The destination file usually exists and
 * already holds resources; this reads it at the base commit and adds the stanza
 * to the end. A file that is not there is created holding the stanza alone,
 * which is the only case where this module writes a whole file — and it never
 * creates a *root*: a boundary that declares none produces
 * `RemediationDestination`'s `absent` arm and no pull request at all, because
 * a root has a backend, a provider and a version pin that nothing here
 * observed.
 */
import type { GeneratedRemediation } from '../../domain/remediation.ts';
import type {
  RepositoryRef,
  RepositoryWriter,
} from '../../domain/repository.ts';

/** Where a remediation branch is cut, one directory per boundary. */
export const REMEDIATION_BRANCH_PREFIX = 'spindrift/remediate';

/** The branch one prerequisite's change is opened from. */
export function remediationBranch(
  vessel: string,
  prerequisite: string,
): string {
  return `${REMEDIATION_BRANCH_PREFIX}/${vessel}-${prerequisite.toLowerCase().replace(/_/g, '-')}`;
}

/** The composed change, before anything has been sent anywhere. */
export interface RemediationTransaction {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Repository-relative path the stanza is added to. */
  readonly path: string;
  readonly stanza: string;
}

/** What the pull request says, in the order an operator reads it. */
function pullRequestBody(input: {
  readonly vessel: string;
  readonly prerequisite: string;
  readonly path: string;
  readonly summary: string;
}): string {
  return `Spindrift wrote this. It checks ${input.vessel} on a standing loop, found \`${input.prerequisite}\` unmet, and this is the change that clears it.

${input.summary}

Merging this is not what clears the row — applying it is. Once it has been applied, the next pass of that loop observes the boundary again and the row goes green on its own; nothing has to be pressed here afterwards. An unmerged or closed pull request changes nothing at all.

The only file touched is \`${input.path}\`, and the only thing added to it is the stanza below the diff. Spindrift enables no service, creates no identity and mutates no boundary itself — it reads, states what is missing, and opens this.
`;
}

/**
 * Compose the change. Pure: nothing is sent, so a test can read exactly what
 * would be written before deciding whether a far side is involved.
 *
 * Refuses a remediation whose destination is a root that is not declared, for
 * the reason the destination has two arms at all — there is no path to write
 * to, and inventing one is what this whole module declines to do.
 */
export function remediationTransaction(input: {
  readonly vessel: string;
  readonly prerequisite: string;
  readonly remediation: GeneratedRemediation;
}): RemediationTransaction {
  const { destination } = input.remediation;
  if (destination.kind !== 'root') {
    throw new RangeError(
      `${input.vessel} declares no Terraform root, so there is nowhere to open this change`,
    );
  }
  return {
    branch: remediationBranch(input.vessel, input.prerequisite),
    title: `${input.vessel}: clear ${input.prerequisite}`,
    body: pullRequestBody({
      vessel: input.vessel,
      prerequisite: input.prerequisite,
      path: destination.path,
      summary: input.remediation.summary,
    }),
    commitMessage: `Clear ${input.prerequisite} on ${input.vessel}`,
    path: destination.path,
    stanza: input.remediation.terraform,
  };
}

/**
 * What opening the change needs: the writer, plus the two reads that find the
 * base commit and whatever the destination file already holds.
 */
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

/** Where the opened pull request can be found, and what it did. */
export interface OpenedRemediationPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly commit: string;
  readonly path: string;
  /** True when the destination file did not exist and this created it. */
  readonly createdFile: boolean;
}

/** The stanza added to whatever the file already held, with one blank line. */
function appended(existing: string | null, stanza: string): string {
  if (existing === null || existing.trim() === '') return stanza;
  return `${existing.replace(/\n+$/, '')}\n\n${stanza}`;
}

/**
 * Write the change to a branch and open the pull request for it.
 *
 * The base is the default branch, read here rather than taken as a parameter,
 * for the reason `config-pr.ts` gives: the branch must not be cut from a ref
 * other than the one whose merge is what will be applied.
 */
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
