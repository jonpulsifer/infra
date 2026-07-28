/**
 * The one configuration pull request (§15).
 *
 * §15: "**One human-editable configuration PR per repository is the
 * transaction**, carrying each App subpath's Spindrift file and one thin CI
 * caller. Only its default-branch merge push becomes authoritative."
 *
 * Every word of that is load-bearing here:
 *
 * - **One PR, not one per scope.** Connecting a monorepo with four Apps is one
 *   thing an operator reviews and merges, not four. That is why this module
 *   composes a file *set* and writes it as a single commit rather than
 *   exposing a per-scope call somebody would loop over.
 * - **Human-editable**, which is why the Spindrift file is emitted by
 *   {@link serializeSpindriftFile} rather than by a general YAML writer. A
 *   general writer produces valid flow-style YAML — `{version: 1, component:
 *   {kind: service}}` — and nobody edits that. The shape is closed and small,
 *   so writing it out block-style costs a few lines and buys a file a person
 *   will actually change.
 * - **Exactly the Spindrift files plus one CI caller.** Nothing else goes in
 *   the tree. A configuration PR that also touched a lockfile, a README, or a
 *   second workflow would be a PR whose review is about something other than
 *   the connection.
 * - **Nothing here is authoritative.** This module opens a PR and returns its
 *   number. It writes no App, no Component, and no Build; the repo loop adopts
 *   configuration only from the default branch, so an unmerged PR — including
 *   one this module just opened — changes nothing.
 */
import type { DetectionProposal } from '../../domain/detection/ladder.ts';
import type {
  RepositoryRef,
  RepositoryWriter,
} from '../../domain/repository.ts';

/** The Spindrift file's name inside each scope (§5). */
export const SPINDRIFT_FILE = 'spindrift.yaml';

/** The one CI caller the transaction carries. */
export const WORKFLOW_PATH = '.github/workflows/spindrift.yml';

/**
 * The caller's file name, which is what a dispatch addresses.
 *
 * The same in every repository — including the platform's own, which commits a
 * caller by hand for the archive builds that have no repository of their own —
 * so the build route addresses one name rather than branching on which kind of
 * repository it is dispatching into.
 */
export const CALLER_WORKFLOW_FILE = WORKFLOW_PATH.slice(
  WORKFLOW_PATH.lastIndexOf('/') + 1,
);

/**
 * The prefix a correlated run's name carries, so a human can read it too.
 *
 * Declared beside the caller that stamps it rather than beside the route that
 * matches on it: the two have to agree exactly, and the file that *writes* the
 * `run-name` is the one that decides what it says.
 */
export const RUN_NAME_PREFIX = 'spindrift';

/** The branch the configuration PR is opened from. */
export const CONFIG_BRANCH = 'spindrift/configure';

/** One scope's proposal, as detection produced it. */
export interface ConfigurationScope {
  /** Repo-relative directory, `.` for the repository root (§5's named scope). */
  readonly scope: string;
  readonly proposal: DetectionProposal;
}

/** One file the pull request writes. */
export interface ConfigurationFile {
  /** Repo-relative path. */
  readonly path: string;
  readonly contents: string;
}

/** The composed transaction, before anything has been sent anywhere. */
export interface ConfigurationTransaction {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  readonly files: readonly ConfigurationFile[];
}

/** Quote a scalar only where YAML would otherwise read it as something else. */
function scalar(value: string): string {
  return /^[A-Za-z0-9][\w./-]*$/.test(value) ? value : JSON.stringify(value);
}

/**
 * Serialize one scope's detection proposal as its in-repo Spindrift file.
 *
 * §15 calls this "a **lossless** serialization of Spindrift's config for one
 * git-integrated scope". Lossless is checkable rather than asserted: what comes
 * out of here parses back through `parseSpindriftFile` to the same proposal,
 * and the test that says so is the only thing keeping the two in step as the
 * schema grows.
 *
 * `kinds` is deliberately *not* emitted. It is the disabled-with-reasons
 * grammar the UI renders (§5) — a statement about what detection considered,
 * not about what this scope is. Writing it into the repository would make a
 * reason somebody read once into a value the next detection run has to honour.
 */
export function serializeSpindriftFile(proposal: DetectionProposal): string {
  const lines = [
    '# Managed by Spindrift, and yours to edit.',
    '#',
    '# This file is what Spindrift knows about this directory. Once it is on the',
    '# default branch it is authoritative: what is written here wins over what',
    '# detection would otherwise guess.',
    'version: 1',
    'component:',
    `  kind: ${proposal.kind}`,
    'build:',
    `  frontend: ${proposal.build.frontend}`,
  ];

  if (proposal.build.frontend === 'dockerfile') {
    lines.push(`  file: ${scalar(proposal.build.dockerfile)}`);
  } else {
    const { buildCommand, outputDirectory } = proposal.build;
    lines.push(
      `  command: ${buildCommand === null ? 'null' : scalar(buildCommand)}`,
      `  outputDirectory: ${outputDirectory === null ? 'null' : scalar(outputDirectory)}`,
    );
  }

  lines.push('watchPaths:');
  for (const path of proposal.watchPaths) {
    lines.push(`  - ${scalar(path)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The thin CI caller (§4, §15).
 *
 * Thin is the requirement, and it has two halves. **The run happens in the
 * connected repository** — §15 gives that repository the Actions minutes and
 * the billing — while **the machinery lives in the pinned reusable workflow**,
 * so what lands in somebody's repo is a dispatch trigger and a `uses:`.
 *
 * The single opaque `spec` input is what keeps it thin over time. A caller with
 * one input per build parameter would have to be regenerated — and re-reviewed,
 * in every connected repository — each time a build gained a parameter. The
 * reusable workflow is pinned by commit and versioned by the platform, so it is
 * the right place for that shape to live.
 *
 * **`correlation` is the one exception, and it is not a build parameter.** The
 * dispatch API answers `204` and names no run, so a dispatched build has to be
 * found again; stamping the value into `run-name` is what makes finding it
 * exact rather than a race against whoever else pushed. It stays out of `spec`
 * because nothing about the build depends on it — the reusable workflow never
 * reads it.
 *
 * `id-token: write` is the workflow-ref-scoped cloud identity §15 names: the
 * job federates as itself rather than holding a credential this file would
 * have to carry.
 */
export function buildWorkflowCaller(buildWorkflow: string): string {
  return `# Managed by Spindrift.
#
# Spindrift dispatches this workflow when it needs a build. The run happens
# here, on this repository’s own Actions minutes; everything it does lives in
# the reusable workflow below, which is pinned by commit.
name: ${RUN_NAME_PREFIX}
run-name: ${RUN_NAME_PREFIX} \${{ inputs.correlation }}
on:
  workflow_dispatch:
    inputs:
      spec:
        description: The build request, as JSON. Spindrift fills this in.
        required: true
        type: string
      correlation:
        description: How Spindrift finds this run again. Not a build input.
        required: true
        type: string
permissions:
  contents: read
  id-token: write
jobs:
  build:
    uses: ${buildWorkflow}
    with:
      spec: \${{ inputs.spec }}
`;
}

/** What the pull request body says, in the order an operator reads it. */
function pullRequestBody(scopes: readonly ConfigurationScope[]): string {
  const rows = scopes
    .map(
      ({ scope, proposal }) =>
        `| \`${scope}\` | ${proposal.kind} | ${proposal.build.frontend} | ${proposal.source} |`,
    )
    .join('\n');

  return `Spindrift wrote this. Merging it into the default branch is what connects this repository — nothing here takes effect until then, and an unmerged or closed pull request changes nothing.

| scope | kind | build | detected by |
| --- | --- | --- | --- |
${rows}

Each \`${SPINDRIFT_FILE}\` is yours to edit, here or later. Once it is on the default branch it wins over detection.

\`${WORKFLOW_PATH}\` runs builds for this repository on its own Actions minutes. It calls a reusable workflow pinned by commit.
`;
}

/**
 * Compose the transaction. Pure: nothing is sent, so a test can read exactly
 * what would be written before deciding whether a far side is involved.
 */
export function configurationTransaction(input: {
  readonly scopes: readonly ConfigurationScope[];
  readonly buildWorkflow: string;
}): ConfigurationTransaction {
  if (input.scopes.length === 0) {
    throw new RangeError(
      'a configuration pull request needs at least one scope',
    );
  }

  const files: ConfigurationFile[] = input.scopes.map(
    ({ scope, proposal }) => ({
      path: scope === '.' ? SPINDRIFT_FILE : `${scope}/${SPINDRIFT_FILE}`,
      contents: serializeSpindriftFile(proposal),
    }),
  );
  files.push({
    path: WORKFLOW_PATH,
    contents: buildWorkflowCaller(input.buildWorkflow),
  });

  const scopeCount =
    input.scopes.length === 1 ? '1 scope' : `${input.scopes.length} scopes`;
  return {
    branch: CONFIG_BRANCH,
    title: `Connect this repository to Spindrift (${scopeCount})`,
    body: pullRequestBody(input.scopes),
    commitMessage: 'Add Spindrift configuration',
    files,
  };
}

/**
 * What opening the transaction needs: the writer, plus the one read that finds
 * the base commit.
 *
 * Declared as an intersection of the domain's interfaces rather than restated,
 * so `GitHubApp` satisfying `RepositoryHost` is the same fact as it satisfying
 * this.
 */
export type ConfigurationHost = RepositoryWriter & {
  branchHead(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
  ): Promise<string>;
};

/** Where the opened pull request can be found. */
export interface OpenedConfigurationPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly commit: string;
}

/**
 * Write the transaction to a branch and open the pull request for it.
 *
 * The base is the default branch, and it is read here rather than taken as a
 * parameter so the branch cannot be cut from a ref that is not the one whose
 * merge will be authoritative.
 */
export async function openConfigurationPullRequest(
  host: ConfigurationHost,
  ref: RepositoryRef,
  input: {
    readonly fullName: string;
    readonly defaultBranch: string;
    readonly transaction: ConfigurationTransaction;
  },
): Promise<OpenedConfigurationPullRequest> {
  const { fullName, defaultBranch, transaction } = input;

  const base = await host.branchHead(ref, fullName, defaultBranch);
  const baseTree = await host.commitTree(ref, fullName, base);

  const entries = await Promise.all(
    transaction.files.map(async (file) => ({
      path: file.path,
      blob: await host.createBlob(ref, fullName, file.contents),
    })),
  );

  const tree = await host.createTree(ref, fullName, baseTree, entries);
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

  return { number, branch: transaction.branch, commit };
}
