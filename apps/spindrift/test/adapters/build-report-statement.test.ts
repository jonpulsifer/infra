/**
 * Runs the hosted route's report step as the workflow file ships it, with a
 * `docker` shim on `PATH` so the base-digest probe never leaves the machine.
 */
import { describe, expect, test } from 'bun:test';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubActionsBuildRoute } from '../../src/adapters/build/github-actions.ts';
import { parseBuildReport } from '../../src/adapters/build/report.ts';

const WORKFLOW = join(
  import.meta.dir,
  '../../../../.github/workflows/spindrift-build.yml',
);
const REPORT_STEP = 'Report what was built';

const BUNDLE_DIGEST = `sha256:${'b'.repeat(64)}`;
const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const DESTINATION = 'ghcr.io/jonpulsifer/spindrift/demo/web';
/** The report carries one reference per destination registry. */
const AR_DESTINATION =
  'northamerica-northeast1-docker.pkg.dev/trusted-builds/i/demo/web';
const DESTINATIONS = [DESTINATION, AR_DESTINATION];

const BASE_DIGEST = `sha256:${'c'.repeat(64)}`;

/**
 * An absent `docker` and an unreachable registry look the same to the step:
 * no stdout and a non-zero exit.
 */
const UNREACHABLE = 'exit 1';

/** Buildx names the base in a package URL, so its digest reads `sha256%3A…`. */
const PROVENANCE = `cat <<'JSON'
{"SLSA":{"materials":[{"uri":"pkg:docker/library/alpine@${BASE_DIGEST.replace(':', '%3A')}?platform=linux%2Famd64"}]}}
JSON`;

async function reportScript(): Promise<string> {
  const document = Bun.YAML.parse(await Bun.file(WORKFLOW).text()) as {
    jobs: { build: { steps: { name?: string; run?: string }[] } };
  };
  const step = document.jobs.build.steps.find((s) => s.name === REPORT_STEP);
  if (step?.run === undefined) {
    throw new Error(`${WORKFLOW} has no “${REPORT_STEP}” step with a script`);
  }
  return step.run;
}

/**
 * Only `docker` is shimmed, because the step's `jq`, `grep` and `sed` parsing
 * is what is under test.
 */
async function runReportStep(docker: string = UNREACHABLE) {
  const directory = await mkdtemp(join(tmpdir(), 'spindrift-report-'));
  try {
    const script = join(directory, 'report.sh');
    await writeFile(script, await reportScript());

    // The argv log tells a probe that answered null from one that never ran.
    const argv = join(directory, 'docker-argv');
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(argv)}\n${docker}\n`,
    );
    await chmod(join(bin, 'docker'), 0o755);
    // GitHub runs `run:` blocks under bash, and the step's `set -o pipefail` is
    // not a legal option in dash.
    const child = Bun.spawn(['bash', script], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        PATH: `${bin}:${Bun.env.PATH ?? ''}`,
        BUNDLE_DIGEST,
        DESTINATION,
        DESTINATIONS: DESTINATIONS.join('\n'),
        DIGEST: IMAGE_DIGEST,
        GITHUB_REPOSITORY: 'jonpulsifer/infra',
        GITHUB_RUN_ID: '12345',
        GITHUB_WORKFLOW_REF:
          'jonpulsifer/infra/.github/workflows/spindrift-build.yml@refs/heads/main',
      },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return {
      stdout,
      stderr,
      exitCode,
      argv: await readFile(argv, 'utf8').catch(() => ''),
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the hosted route reports a statement admission can read', () => {
  test('the step prints a report core can parse', async () => {
    const { stdout, exitCode } = await runReportStep();
    expect(exitCode).toBe(0);

    const report = parseBuildReport(stdout);
    expect(report).not.toBeNull();
    expect(report?.bundleDigest).toBe(BUNDLE_DIGEST);
    expect(report?.digest).toBe(IMAGE_DIGEST);
    // In destination order, since a Target that declares no reachable
    // registries gets `refs[0]`.
    expect(report?.refs).toEqual(
      DESTINATIONS.map((destination) => `${destination}@${IMAGE_DIGEST}`),
    );
    expect(report?.baseDigest).toBeNull();
  });

  test('a base the registry will not answer for is reported as null', async () => {
    const { exitCode, argv, stdout } = await runReportStep(UNREACHABLE);

    expect(argv).toContain(`${DESTINATION}@${IMAGE_DIGEST}`);
    expect(exitCode).toBe(0);
    expect(parseBuildReport(stdout)?.baseDigest).toBeNull();
  });

  test('a base the registry does answer for survives percent-decoding', async () => {
    const { exitCode, stdout } = await runReportStep(PROVENANCE);
    expect(exitCode).toBe(0);

    expect(parseBuildReport(stdout)?.baseDigest).toBe(BASE_DIGEST);
  });

  test('the statement binds the bundle, the artifact, and the builder', async () => {
    const { stdout } = await runReportStep();
    const statement = parseBuildReport(stdout)?.statement as {
      subject: { digest: { sha256: string } }[];
      predicateType: string;
      predicate: {
        buildDefinition: { externalParameters: { bundleDigest: string } };
        runDetails: { builder: { id: string } };
      };
    };

    expect(
      statement.predicate.buildDefinition.externalParameters.bundleDigest,
    ).toBe(BUNDLE_DIGEST);
    // in-toto digests are bare hex; the verifier re-adds the prefix.
    expect(statement.subject[0]?.digest.sha256).toBe(
      IMAGE_DIGEST.replace('sha256:', ''),
    );
    expect(statement.predicateType).toBe('https://slsa.dev/provenance/v1');

    // The verifier's `--builder-id` comes from the route profile, so the
    // workflow and this constant must agree.
    const route = new GitHubActionsBuildRoute({
      name: 'hosted',
      host: {} as never,
      buildWorkflow:
        'jonpulsifer/infra/.github/workflows/spindrift-build.yml@abc',
      zeroConfigFrontend: 'ghcr.io/railwayapp/railpack-frontend:v0.35.0',
      signer: '',
      attestor: '',
    });
    expect(statement.predicate.runDetails.builder.id).toBe(
      route.provenanceBuilderId,
    );
  });
});
