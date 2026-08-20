/**
 * The hosted route's report step, run as the file actually ships it.
 *
 * Every other test in this tree stands a fake in front of the runner, and the
 * fake (`test/harness/fakes/build-adapter.ts`) composes a well-formed SLSA
 * statement — so a workflow emitting `{run, workflow}` instead passed the whole
 * suite and refused every real build at admission, after the image was pushed.
 * A fixture cannot catch that. Running the step's own `run:` script can.
 *
 * The step's base-digest probe shells out to `docker buildx imagetools inspect`,
 * and this file supplies its own `docker` on `PATH` rather than letting the box
 * decide. Inheriting the runner's `PATH` made the probe an unbounded network
 * call: a hosted runner has Docker and the buildx plugin — the same CI job
 * starts this suite's Postgres with `docker run` — so the lookup left the
 * machine for a digest that does not exist and paid cold DNS, TLS and a
 * registry token exchange inside a 5-second test budget. `|| true` bounds the
 * step's exit code, never its clock. That is what made one test per CI run fail
 * at 5001 ms, a different one each time, and it broke the offline contract the
 * harness states at `test/harness/db.ts`: the only external process is Postgres.
 *
 * A shim also makes the probe testable in both directions, which a box-dependent
 * one never was — `UNREACHABLE` is the `baseDigest: null` §16 wants from a
 * builder that cannot read its own base, and `PROVENANCE` exercises the
 * jq/grep/sed pipeline that turns a percent-encoded package URL into a digest.
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
/**
 * Two, because an installation whose Targets cannot share a registry pushes to
 * each and the report has to carry a reference per registry (ticket 39). One
 * build, one digest, N references — the cluster pulls the first and Cloud Run
 * the second, and a report that carried only one is a Deploy that pins an
 * address its Target cannot reach.
 */
const AR_DESTINATION =
  'northamerica-northeast1-docker.pkg.dev/trusted-builds/i/demo/web';
const DESTINATIONS = [DESTINATION, AR_DESTINATION];

/** The base image `PROVENANCE` names, and what the probe must extract from it. */
const BASE_DIGEST = `sha256:${'c'.repeat(64)}`;

/**
 * A `docker` that cannot answer — the shape this file has always asserted.
 *
 * It stands in for both an absent binary and a registry the runner cannot
 * reach, because the step cannot tell those apart: each writes nothing to
 * stdout and exits non-zero, and `|| true` turns both into `baseDigest: null`.
 */
const UNREACHABLE = 'exit 1';

/**
 * A `docker` that answers the way buildx does, `sha256%3A` and all.
 *
 * The percent-encoding is the point: buildx emits the base as a package URL,
 * so the step greps for `sha256(:|%3A)` and `sed`s the escape back out. A
 * fixture spelling the digest plainly would pass without that arm working.
 */
const PROVENANCE = `cat <<'JSON'
{"SLSA":{"materials":[{"uri":"pkg:docker/library/alpine@${BASE_DIGEST.replace(':', '%3A')}?platform=linux%2Famd64"}]}}
JSON`;

/** The `run:` script of the named step, straight out of the shipped file. */
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
 * Run that script the way a runner does, and read what it printed.
 *
 * `docker` is the only tool the step calls that this repo does not control the
 * behaviour of, so it is the only one shimmed; `jq`, `grep` and `sed` come from
 * the real `PATH` because the step's parsing is what is under test.
 */
async function runReportStep(docker: string = UNREACHABLE) {
  const directory = await mkdtemp(join(tmpdir(), 'spindrift-report-'));
  try {
    const script = join(directory, 'report.sh');
    await writeFile(script, await reportScript());

    // Recorded rather than merely stubbed: a probe that stopped running would
    // still report `baseDigest: null` and still pass the assertion below, so
    // the argv file is what separates "answered null" from "never asked".
    const argv = join(directory, 'docker-argv');
    const bin = join(directory, 'bin');
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, 'docker'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(argv)}\n${docker}\n`,
    );
    await chmod(join(bin, 'docker'), 0o755);
    // `bash`, not `sh`: a GitHub Actions `run:` block runs under
    // `bash --noprofile --norc -e -o pipefail` on a Linux runner, and this step
    // opens with `set -euo pipefail`. Under a POSIX `sh` — dash on the runner
    // this test itself runs on — `set -o pipefail` is not a legal option, `-e`
    // takes the failure, and the step exits before printing anything. Testing
    // it under the wrong shell is testing a script production never executes.
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
    // Only the exit code is asserted: the base-digest probe is `|| true` and
    // whatever it writes to stderr on a box with no registry is noise the step
    // is designed to survive.
    const { stdout, exitCode } = await runReportStep();
    expect(exitCode).toBe(0);

    const report = parseBuildReport(stdout);
    expect(report).not.toBeNull();
    expect(report?.bundleDigest).toBe(BUNDLE_DIGEST);
    expect(report?.digest).toBe(IMAGE_DIGEST);
    // One per destination, in the order core sent them — so `refs[0]` is still
    // the first registry, which is what a Target that declares no reachable
    // registries gets.
    expect(report?.refs).toEqual(
      DESTINATIONS.map((destination) => `${destination}@${IMAGE_DIGEST}`),
    );
    expect(report?.baseDigest).toBeNull();
  });

  test('a base the registry will not answer for is reported as null', async () => {
    const { exitCode, argv, stdout } = await runReportStep(UNREACHABLE);

    // The probe asked, and asked for the immutable reference this build pushed
    // — `baseDigest: null` here is a refusal to guess, not a step that skipped.
    expect(argv).toContain(`${DESTINATION}@${IMAGE_DIGEST}`);
    expect(exitCode).toBe(0);
    expect(parseBuildReport(stdout)?.baseDigest).toBeNull();
  });

  test('a base the registry does answer for survives percent-decoding', async () => {
    const { exitCode, stdout } = await runReportStep(PROVENANCE);
    expect(exitCode).toBe(0);

    // The whole point of the arm: buildx spells the digest `sha256%3A…` inside
    // a package URL, and what admission compares against is `sha256:…`.
    expect(parseBuildReport(stdout)?.baseDigest).toBe(BASE_DIGEST);
  });

  /**
   * The three facts admission reads, and the one that was missing: without
   * `externalParameters.bundleDigest` the verified envelope carries no join to
   * the source receipt and `verify.ts` refuses with "does not bind the source
   * bundle digest" — on a build whose blobs are already in the registry.
   */
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
    // Bare hex, which is what in-toto says and what the verifier re-prefixes
    // before comparing it to the digest it pulled off the immutable reference.
    expect(statement.subject[0]?.digest.sha256).toBe(
      IMAGE_DIGEST.replace('sha256:', ''),
    );
    expect(statement.predicateType).toBe('https://slsa.dev/provenance/v1');

    // The expectation is the route profile's, passed to the verifier as
    // `--builder-id`; a workflow naming anything else is refused as a builder
    // mismatch. These two constants live in different languages and must agree.
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
