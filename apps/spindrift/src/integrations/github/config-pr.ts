/**
 * The configuration pull request: one per repository, one commit holding each
 * scope's `spindrift.yaml` and one CI caller. Nothing takes effect until it is
 * merged to the default branch.
 */
import type { DetectionProposal } from '../../domain/detection/ladder.ts';
import type {
  RepositoryRef,
  RepositoryWriter,
} from '../../domain/repository.ts';

export const SPINDRIFT_FILE = 'spindrift.yaml';

export const WORKFLOW_PATH = '.github/workflows/spindrift.yml';

/**
 * What a dispatch addresses. The same in every repository, including the
 * platform's own, which commits its caller by hand.
 */
export const CALLER_WORKFLOW_FILE = WORKFLOW_PATH.slice(
  WORKFLOW_PATH.lastIndexOf('/') + 1,
);

/** The caller stamps it into the run name, and the build route matches on it. */
export const RUN_NAME_PREFIX = 'spindrift';

export const CONFIG_BRANCH = 'spindrift/configure';

export interface ConfigurationScope {
  /** Repo-relative directory; `.` is the root. */
  readonly scope: string;
  readonly proposal: DetectionProposal;
}

export interface ConfigurationFile {
  /** Repo-relative. */
  readonly path: string;
  readonly contents: string;
}

export interface ConfigurationTransaction {
  readonly branch: string;
  readonly title: string;
  readonly body: string;
  readonly commitMessage: string;
  readonly files: readonly ConfigurationFile[];
}

/** Anything outside this needs quoting for YAML to read it as written. */
const PLAIN = /^[A-Za-z0-9][\w./-]*$/;

/**
 * Plain scalars YAML reads as a boolean, null or number. Left bare, a
 * `buildCommand` of `true` parses back as a boolean and the file is refused.
 */
const TYPED =
  /^(?:true|false|null|~|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/i;

function scalar(value: string): string {
  return PLAIN.test(value) && !TYPED.test(value)
    ? value
    : JSON.stringify(value);
}

/**
 * Parses back through `parseSpindriftFile` to the same proposal. `kinds` is
 * left out because it records what detection considered.
 */
export function serializeSpindriftFile(
  // Narrowed so the creation screen can preview the file from an inspection.
  proposal: Pick<DetectionProposal, 'kind' | 'build' | 'watchPaths'>,
): string {
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
 * One opaque `spec` input, so a new build parameter never touches the caller.
 * A called workflow can only narrow the token, so permissions are granted here.
 */
export function buildWorkflowCaller(buildWorkflow: string): string {
  return `# Managed by Spindrift.
#
# Spindrift dispatches this workflow when it needs a build. The run happens
# here, on this repository’s own Actions minutes; everything it does lives in
# the reusable workflow below, which the platform versions.
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
  packages: write
  id-token: write
jobs:
  build:
    uses: ${buildWorkflow}
    with:
      spec: \${{ inputs.spec }}
`;
}

function pullRequestBody(scopes: readonly ConfigurationScope[]): string {
  const rows = scopes
    .map(
      ({ scope, proposal }) =>
        `| \`${scope}\` | ${proposal.kind} | ${proposal.build.frontend} | ${proposal.source} |`,
    )
    .join('\n');

  return `Spindrift wrote this. Merging it into the default branch is what connects this repository — nothing here takes effect until then, and an unmerged or closed pull request changes nothing.

| scope | kind | build | proposed by |
| --- | --- | --- | --- |
${rows}

Each \`${SPINDRIFT_FILE}\` is yours to edit, here or later. Once it is on the default branch it wins over detection.

\`${WORKFLOW_PATH}\` runs builds for this repository on its own Actions minutes. It calls a reusable workflow the platform versions.
`;
}

/** Pure: nothing is sent. */
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

export type ConfigurationHost = RepositoryWriter & {
  branchHead(
    ref: RepositoryRef,
    fullName: string,
    branch: string,
  ): Promise<string>;
};

export interface OpenedConfigurationPullRequest {
  readonly number: number;
  readonly branch: string;
  readonly commit: string;
}

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
