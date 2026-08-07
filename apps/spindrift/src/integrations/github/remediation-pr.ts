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
 *
 * **And appending is checked before it is done.** A file that already declares
 * what the stanza declares is a file that already owns the fact, and adding a
 * second declaration is drift where the labels differ and a root that does not
 * parse where they match. That is not hypothetical against this repository: the
 * bucket, the enabled services and the bound roles a generated stanza names are
 * all declared in the roots the vessels point at. So the read this module
 * already makes is used for something, and {@link AlreadyDeclaredError} is the
 * answer — a refusal naming the file, rather than a pull request whose plan
 * errors.
 */
import type { TargetAdapter } from '../../config/manifest.schema.ts';
import type { GeneratedRemediation } from '../../domain/remediation.ts';
import type {
  RepositoryRef,
  RepositoryWriter,
} from '../../domain/repository.ts';

/** Where a remediation branch is cut, one directory per boundary. */
export const REMEDIATION_BRANCH_PREFIX = 'spindrift/remediate';

/**
 * The branch one prerequisite's change is opened from.
 *
 * The surface is in the name, and leaving it out was a collision rather than a
 * cosmetic gap: `PREREQUISITES_BY_ADAPTER` puts `PLATFORM_API` and
 * `OIDC_FEDERATION` on both cloud surfaces of one vessel, so a `gcp-project`
 * routinely has two unmet rows of the same name that want different stanzas —
 * one enabling Cloud Run, one Firebase Hosting. Sharing a branch, the second
 * open force-pushes over the first and the repository host answers the second
 * pull request with the first one's number, so an operator is told a change was
 * opened that no longer exists anywhere. `null` for a row that belongs to the
 * boundary itself, which has no surface to name.
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

/** The composed change, before anything has been sent anywhere. */
export interface RemediationTransaction {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  /** Repository-relative path the stanza is added to. */
  readonly path: string;
  readonly stanza: string;
  /** What the destination must not already declare — see `remediation.ts`. */
  readonly declares: readonly string[];
}

/** The boundary and, where the row is on one, the surface — in one phrase. */
function subjectOf(vessel: string, adapter: TargetAdapter | null): string {
  return adapter === null ? vessel : `${vessel}’s ${adapter} surface`;
}

/** What the pull request says, in the order an operator reads it. */
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
 * Compose the change. Pure: nothing is sent, so a test can read exactly what
 * would be written before deciding whether a far side is involved.
 *
 * Refuses a remediation whose destination is a root that is not declared, for
 * the reason the destination has two arms at all — there is no path to write
 * to, and inventing one is what this whole module declines to do.
 */
export function remediationTransaction(input: {
  readonly vessel: string;
  /** The surface the row is on, `null` for a row that is the boundary's own. */
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

/** The destination already owns this fact, so there is nothing to add. */
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

/** The stanza added to whatever the file already held, with one blank line. */
function appended(existing: string | null, stanza: string): string {
  if (existing === null || existing.trim() === '') return stanza;
  return `${existing.replace(/\n+$/, '')}\n\n${stanza}`;
}

/**
 * Whichever fact the destination already holds, or `null` for a file with none
 * of them.
 *
 * Two distinct failures, and this refuses ahead of both. Where the resource
 * *address* repeats, the appended file is a `Duplicate resource configuration`
 * that fails to parse — so the pull request Spindrift just opened breaks the
 * plan for every other change queued against that root, and the row can never
 * go green because nothing can be applied. Where only the value repeats, it
 * parses and is worse: two resources managing one API enablement or one
 * binding, which is exactly the drift `AGENTS.md` prohibits and which applies
 * cleanly enough that nobody catches it.
 *
 * Re-opening the same row after a merge that has not been applied yet lands
 * here too, and it is the same answer: the base branch now carries the stanza,
 * the row is still red because Atlantis has not run, and appending a second
 * copy is not what moves it.
 */
function alreadyDeclared(
  existing: string | null,
  declares: readonly string[],
): string | null {
  if (existing === null) return null;
  return declares.find((fact) => existing.includes(fact)) ?? null;
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
