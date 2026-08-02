/**
 * The hosted-CI build route (§4).
 *
 * §4 puts the default build "somewhere with a fast pipe rather than at home
 * behind Starlink", and §15 puts the run in the connected repository: "the
 * connected repo owns its Actions minutes; a **SHA-pinned reusable workflow**
 * plus a workflow-ref-scoped cloud identity hold the machinery." Everything
 * awkward about this file follows from that one arrangement.
 *
 * **Three consequences worth knowing before reading the code.**
 *
 * 1. **Dispatch names no run.** The dispatch API answers `204` and says nothing
 *    about what it started, so the run has to be *found*. That is why the
 *    caller workflow carries a correlation input it stamps into `run-name`:
 *    matching on a name this route minted is exact, where matching on "the
 *    newest run since I asked" is a race with anyone else pushing.
 * 2. **The result comes back through the log.** Logs are read and never pushed
 *    (§4), so there is no endpoint for a runner to post a digest to — the
 *    runner prints one marker line and this route reads it out of the log it
 *    was already fetching. See `report.ts`.
 * 3. **An archive builds in the platform's own repository.** A repo App runs on
 *    its own minutes, but an uploaded archive has no repository at all — so it
 *    runs where the reusable workflow lives, which the installation already
 *    named in `github.buildWorkflow`. That workflow declares `workflow_call`
 *    and `workflow_dispatch` for exactly this reason.
 *
 * `LIVE_STATUS`, declared and not measured: on a hosted runner the step
 * transitions are readable while the run goes and the text only lands at the
 * end (§4, and the amendment in `04-build-path.md`). §4 makes that visible on
 * the Build rather than hidden, because a checklist-only log is a property of
 * where it ran and not a bug in Spindrift.
 */
import type { RepositoryRef } from '../../domain/repository.ts';
import {
  CALLER_WORKFLOW_FILE,
  RUN_NAME_PREFIX,
} from '../../integrations/github/config-pr.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

/** One run of a workflow, as much of it as this route reads. */
export interface ActionsRun {
  readonly id: number;
  /** The `run-name` the caller stamped, which is how a run is correlated. */
  readonly name: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  /**
   * The run's page on the host, where its log can be watched live.
   *
   * Nullable because it is the host's to report and this route does not
   * compose one from the run id — a URL this module invented would be a guess
   * about a layout GitHub owns, and a wrong guess is a dead link offered as
   * the remedy for an empty log.
   */
  readonly htmlUrl: string | null;
}

/** One job of a run, and the steps inside it. */
export interface ActionsJob {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly steps?: readonly {
    readonly name: string;
    readonly status: string;
    readonly conclusion: string | null;
  }[];
}

/**
 * The far side this route drives.
 *
 * Declared here rather than imported from the integration, the same way
 * `ConfigurationHost` is: what this route needs is six calls, and naming them
 * is what lets a test stand a fake behind the real client without the fake
 * having to be a GitHub App.
 */
export interface ActionsHost {
  installationFor(fullName: string): Promise<RepositoryRef>;
  repository(
    ref: RepositoryRef,
    fullName: string,
  ): Promise<{ readonly defaultBranch: string }>;
  dispatchWorkflow(
    ref: RepositoryRef,
    fullName: string,
    input: {
      readonly workflow: string;
      readonly branch: string;
      readonly inputs: Readonly<Record<string, string>>;
    },
  ): Promise<void>;
  workflowRuns(
    ref: RepositoryRef,
    fullName: string,
    input: { readonly workflow: string; readonly branch: string },
  ): Promise<readonly ActionsRun[]>;
  workflowRun(
    ref: RepositoryRef,
    fullName: string,
    runId: number,
  ): Promise<{
    readonly id: number;
    readonly status: string;
    readonly conclusion: string | null;
  } | null>;
  runJobs(
    ref: RepositoryRef,
    fullName: string,
    runId: number,
  ): Promise<readonly ActionsJob[]>;
  jobLog(
    ref: RepositoryRef,
    fullName: string,
    jobId: number,
  ): Promise<string | null>;
}

export interface GitHubActionsRouteOptions extends PollingOptions {
  readonly name: string;
  readonly host: ActionsHost;
  /**
   * The reusable workflow, `owner/repo/.github/workflows/<file>@<sha>`, exactly
   * as the manifest pins it.
   *
   * Only the repository half is read here, and the reason is the pin: a
   * dispatch names a *branch*, so dispatching the reusable workflow directly
   * would run whatever is on the default branch and discard the commit §15
   * requires. This route therefore always dispatches a **caller** — the one the
   * configuration PR wrote in a connected repository, or the one committed
   * beside the reusable workflow here — and the caller is what holds the pin.
   */
  readonly buildWorkflow: string;
  /** The zero-config BuildKit frontend the installation pinned (§4). */
  readonly zeroConfigFrontend: string;
  /** The installation's signing key (§16). See `BuildRequestSpec.signer`. */
  readonly signer: string;
  /** The attestor a cloud Target's admission asks. See `BuildRequestSpec.attestor`. */
  readonly attestor: string;
  /** Injected so a test can pin the correlation it asserts on. */
  readonly correlation?: () => string;
  /** How long to keep looking for the run a dispatch started. */
  readonly discoveryMs?: number;
}

/** Long enough for a queued run to appear, short enough to fail visibly. */
export const DEFAULT_RUN_DISCOVERY_MS = 120_000;

/**
 * Where an archive builds: the repository half of the pinned reference.
 *
 * The manifest schema already refuses anything that does not match this shape,
 * so a failure here is a programming error rather than a configuration one —
 * hence the throw. `null` would push a check onto every call site for a state
 * the boot already made impossible.
 */
export function reusableWorkflowRepository(reference: string): string {
  const match = /^([^/@\s]+\/[^/@\s]+)\/\.github\/workflows\/[^@\s]+@/.exec(
    reference,
  );
  if (match === null) {
    throw new TypeError(
      `not a pinned reusable workflow reference: ${reference}`,
    );
  }
  return match[1] as string;
}

/** What the workflow is handed, and what the reusable workflow reads back. */
export interface BuildRequestSpec {
  readonly bundleDigest: string;
  readonly origin: BuildSource['origin'];
  readonly artifactType: BuildSpec['artifactType'];
  readonly kind: BuildSpec['kind'];
  readonly platform: BuildSpec['platform'];
  /** The repository, without a tag. */
  readonly destination: string;
  /** What to push it as (§12); the workflow tags with these and no others. */
  readonly tags: readonly string[];
  readonly buildArgs: Readonly<Record<string, string>>;
  /** Pinned by the installation, never chosen by the runner. */
  readonly zeroConfigFrontend: string;
  /**
   * The installation's signing key, as `supplyChain.signer` names it.
   *
   * Sent rather than baked into the workflow because it is this installation's
   * key and the workflow is not this installation's file — the same reason the
   * registry and the frontend travel in the spec.
   *
   * §16 has core sign the digest, and it still does: the bundle core records
   * and re-verifies at admission is unchanged. What this adds is a *second*
   * signature over the same digest, made with the same key, attached to the
   * artifact **in the registry** — because that is the only place a Target's
   * own admission can read one. A cluster whose policy engine asks cosign
   * whether an image is signed is asking about the registry, and core has no
   * way to answer: a cosign signature is a `sha256-<digest>.sig` object pushed
   * to the repository, and the controller holds no registry write credential.
   * The runner does, having just pushed the artifact with it.
   */
  readonly signer: string;
  /**
   * The attestation authority a cloud Target's own admission asks, as
   * `projects/<project>/attestors/<name>`, or empty where the installation
   * named none.
   *
   * The second half of the same fact `signer` carries, and separate from it
   * because the two boundaries want different objects from the same key. A
   * cluster's policy engine reads a signature off the artifact in the
   * registry; a cloud runtime's Binary Authorization reads an *attestation* —
   * a note occurrence in the authority's own project, which is not in the
   * registry at all and cannot be derived from a signature that is. One key,
   * two verifiers, two artifacts.
   */
  readonly attestor: string;
}

export class GitHubActionsBuildRoute implements BuildAdapter {
  readonly name: string;
  readonly logFidelity: LogFidelity = 'LIVE_STATUS';
  readonly provenanceBuilderId =
    'https://github.com/actions/runner/github-hosted';
  /**
   * §16's profile level. A reusable workflow pinned by commit, running on a
   * runner the repository does not control, producing signed provenance — that
   * is L2. It is not L3: the workflow runs with the connected repository's own
   * permissions, so its own maintainers can reach the build environment.
   */
  readonly buildLevel: BuildLevel = 2;

  /** Where an archive builds, having no repository of its own. */
  private readonly platformRepository: string;

  constructor(private readonly options: GitHubActionsRouteOptions) {
    this.name = options.name;
    this.platformRepository = reusableWorkflowRepository(options.buildWorkflow);
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;
    const { host } = this.options;

    // Where the run happens, in preference order.
    //
    // §15 puts a repo App's build on its own repository's minutes, and an
    // archive has no repository at all so it runs where the reusable workflow
    // lives. The second entry is the same place for a third reason: a connected
    // repository that does not carry the caller yet.
    //
    // **The fallback is sound because the runner never reads the source
    // repository.** §15 stages one immutable bundle and the workflow fetches it
    // by URL — `Fetch the staged bundle` is a `curl`, not a checkout — so the
    // build is byte-identical wherever it runs. What differs is only whose
    // Actions minutes pay for it, which is a billing preference and not a
    // correctness one.
    //
    // Without this, connecting a repository and creating an App on it were one
    // act: the configuration PR had to be merged before the first Build could
    // be dispatched, so the operator had to name every scope up front and wait
    // on a merge to find out whether the thing built at all. Connecting grants
    // access; Apps are created on it afterwards, and the first one builds.
    const candidates =
      source.origin.type === 'repo' &&
      source.origin.repository !== this.platformRepository
        ? [source.origin.repository, this.platformRepository]
        : [this.platformRepository];
    // Always a caller, never the reusable workflow itself — a dispatch names a
    // branch, so dispatching the reusable workflow directly would discard the
    // commit §15 pins. The connected repository runs the caller the
    // configuration PR wrote there; the platform repository runs the one
    // committed beside the reusable workflow. Same file name, same inputs.
    const workflow = CALLER_WORKFLOW_FILE;

    const correlation = (
      this.options.correlation ?? (() => crypto.randomUUID())
    )();
    const runName = `${RUN_NAME_PREFIX} ${correlation}`;

    const request: BuildRequestSpec = {
      bundleDigest: source.bundleDigest,
      origin: source.origin,
      artifactType: spec.artifactType,
      kind: spec.kind,
      platform: spec.platform,
      destination: spec.destination,
      tags: spec.tags,
      buildArgs: spec.buildArgs,
      zeroConfigFrontend: this.options.zeroConfigFrontend,
      signer: this.options.signer,
      attestor: this.options.attestor,
    };

    let repository: string | null = null;
    let ref: RepositoryRef | null = null;
    let branch = '';
    let detail = '';
    for (const candidate of candidates) {
      try {
        const candidateRef = await host.installationFor(candidate);
        const candidateBranch = (await host.repository(candidateRef, candidate))
          .defaultBranch;
        await host.dispatchWorkflow(candidateRef, candidate, {
          workflow,
          branch: candidateBranch,
          inputs: { spec: JSON.stringify(request), correlation },
        });
        repository = candidate;
        ref = candidateRef;
        branch = candidateBranch;
        break;
      } catch (error) {
        // §4 story 48: a failure *before* the build step — dispatch refused,
        // the runner never came up — must be visible as text rather than as an
        // empty log and a spinner. Every attempt is yielded, including the one
        // that is about to be retried elsewhere, because "we tried your
        // repository and it has no caller" is the sentence that explains why
        // the run appears somewhere the operator did not expect.
        detail = error instanceof Error ? error.message : String(error);
        yield {
          type: 'log',
          at: now(),
          line: `could not dispatch ${workflow} in ${candidate}: ${detail}`,
        };
      }
    }
    if (ref === null || repository === null) {
      return buildFailed(
        logs,
        'TARGET_UNREACHABLE',
        `could not dispatch ${workflow} in ${candidates.join(' or ')}: ${detail}`,
        { repositories: candidates, workflow },
      );
    }

    yield {
      type: 'log',
      at: now(),
      line: `dispatched ${workflow} in ${repository} on ${branch} as “${runName}”`,
    };

    const discovery = deadlineFrom({
      ...this.options,
      timeoutMs: this.options.discoveryMs ?? DEFAULT_RUN_DISCOVERY_MS,
    });
    let run: ActionsRun | null = null;
    while (run === null) {
      if (discovery.expired()) {
        yield {
          type: 'log',
          at: now(),
          line: `no run named “${runName}” appeared in ${repository}`,
        };
        return buildFailed(
          logs,
          'TARGET_UNREACHABLE',
          `the workflow was dispatched but no run appeared in ${repository}`,
          { repository, workflow, runName },
        );
      }
      await discovery.tick();
      const runs = await host.workflowRuns(ref, repository, {
        workflow,
        branch,
      });
      run = runs.find((candidate) => candidate.name === runName) ?? null;
    }

    yield { type: 'log', at: now(), line: `run ${run.id} started` };

    // Announced the moment the run is correlated, because this route is
    // `LIVE_STATUS`: the checklist is the only live thing Spindrift can show,
    // and this is where the live *text* is. Emitting it here rather than with
    // the result is what makes it usable during the run instead of after it.
    //
    // Truthiness rather than a null check: a host that omits the field entirely
    // is saying the same thing as one that reports it empty, and an event
    // carrying `undefined` would reach the Build row as a link to nowhere.
    if (run.htmlUrl) {
      yield { type: 'runner', at: now(), url: run.htmlUrl };
    }

    const budget = deadlineFrom(this.options);
    const seen = new Set<string>();
    let conclusion: string | null = null;
    let jobs: readonly ActionsJob[] = [];

    for (;;) {
      jobs = await host.runJobs(ref, repository, run.id);
      for (const event of stepEvents(jobs, seen, now())) yield event;

      const current = await host.workflowRun(ref, repository, run.id);
      if (current !== null && current.status === 'completed') {
        conclusion = current.conclusion;
        break;
      }
      if (budget.expired()) {
        return buildFailed(
          logs,
          'TIMEOUT',
          `run ${run.id} in ${repository} did not finish within the build budget`,
          { runId: run.id },
        );
      }
      await budget.tick();
    }

    // The text lands only now, which is what `LIVE_STATUS` means. Reading it
    // even on a red run is the point: the failure is in there.
    let log = '';
    for (const job of jobs) {
      let text: string | null;
      try {
        text = await host.jobLog(ref, repository, job.id);
      } catch (error) {
        // A verdict of its own, and the reason it is not the dispatch's: by now
        // the workflow has been dispatched, correlated, and concluded, so
        // `dispatch failed:` would name the one part that demonstrably worked
        // and send an operator to read a green run's logs looking for a refusal
        // that is not in them.
        //
        // It is still a failure, because consequence 2 above holds: the report
        // rides the log, so a log this route cannot read is a build that cannot
        // say what it built (`report.ts`). `TARGET_UNREACHABLE` is §6's
        // platform-blamed reason for an API that would not answer, which is
        // exactly what this is — nothing the developer wrote is at fault.
        const detail = error instanceof Error ? error.message : String(error);
        yield {
          type: 'log',
          at: now(),
          line: `could not read the log of job ${job.id}: ${detail}`,
        };
        return buildFailed(
          logs,
          'TARGET_UNREACHABLE',
          `run ${run.id} in ${repository} concluded ${conclusion ?? 'without a conclusion'} but its log could not be read, and a build reports what it built in its log: ${detail}`,
          { runId: run.id, jobId: job.id, conclusion },
        );
      }
      if (text === null) continue;
      log += text;
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        yield { type: 'log', at: now(), line, step: job.name };
      }
    }

    if (conclusion !== 'success') {
      const scaffolding = failedScaffoldingStep(jobs);
      if (scaffolding !== null) {
        return buildFailed(
          logs,
          // §6 blames the **platform** for an object that could not be
          // fetched, which is what this is: the workflow never reached the
          // developer's code because the platform's own preamble did not
          // finish.
          'ARTIFACT_UNAVAILABLE',
          `run ${run.id} in ${repository} failed in “${scaffolding}”, a step of Spindrift's own build workflow rather than of the App's build`,
          { runId: run.id, conclusion, step: scaffolding },
        );
      }
      return buildFailed(
        logs,
        'BUILD_FAILED',
        `run ${run.id} in ${repository} concluded ${conclusion ?? 'without a conclusion'}`,
        { runId: run.id, conclusion },
      );
    }

    const report = parseBuildReport(log);
    if (report === null) {
      // Green run, no report: the workflow ran something other than a Spindrift
      // build. Reporting it as an adapter fault rather than a build failure is
      // deliberate — nothing the developer wrote is at fault for it.
      return buildFailed(
        logs,
        'INTERNAL',
        `run ${run.id} in ${repository} succeeded but reported no artifact`,
        { runId: run.id },
      );
    }

    return buildSucceeded({
      source,
      spec,
      logs,
      level: this.buildLevel,
      report,
    });
  }
}

/**
 * The one step of the reusable workflow the developer owns.
 *
 * Everything else in that file is Spindrift's: reading the request, fetching
 * the staged bundle, choosing a frontend, logging in to the registry, printing
 * the report. The App's own code is compiled in exactly one step, and naming it
 * is what lets this route tell "your build failed" apart from "our scaffolding
 * failed" — a distinction §6 spends its whole blame column on.
 *
 * Coupled to the workflow by name, which is sound only because the manifest
 * pins that workflow by SHA (`github.buildWorkflow`): the file this route
 * dispatches cannot change under it without the pin rolling too.
 */
export const DEVELOPER_BUILD_STEP = 'Build and push';

/**
 * The Spindrift-owned step a red run failed in, or `null` when the App's own
 * build is what failed.
 *
 * This is the fix for a build that reported `blame = developer` for a failure
 * that was entirely the platform's: the workflow was handed a bundle location
 * it could not resolve, died in the fetch step, and the developer was sent to
 * read a Dockerfile that was never compiled. A run that never reached
 * {@link DEVELOPER_BUILD_STEP} cannot have failed because of anything the
 * developer wrote.
 *
 * A run whose jobs report no steps at all answers `null` — the conservative
 * direction, because claiming platform blame without evidence would mask real
 * build failures behind a chip that says "not your fault".
 */
function failedScaffoldingStep(jobs: readonly ActionsJob[]): string | null {
  let scaffolding: string | null = null;
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      if (stepState(step.status, step.conclusion) !== 'FAILED') continue;
      if (step.name === DEVELOPER_BUILD_STEP) return null;
      scaffolding ??= step.name;
    }
  }
  return scaffolding;
}

/**
 * The step transitions not yet yielded.
 *
 * Deduplicated on `(job, step, state)` because the jobs endpoint is polled and
 * reports the same completed step on every pass — without this the timeline
 * would repeat every step once per poll, which reads as a build looping.
 */
function stepEvents(
  jobs: readonly ActionsJob[],
  seen: Set<string>,
  at: Date,
): BuildEvent[] {
  const events: BuildEvent[] = [];
  for (const job of jobs) {
    for (const step of job.steps ?? []) {
      const state = stepState(step.status, step.conclusion);
      if (state === null) continue;
      const key = `${job.name}/${step.name}/${state}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push({
        type: 'step',
        at,
        step: `${job.name} / ${step.name}`,
        state,
      });
    }
  }
  return events;
}

/** A step's state, or `null` for one that has not started and has nothing to say. */
function stepState(
  status: string,
  conclusion: string | null,
): 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null {
  if (status === 'in_progress') return 'RUNNING';
  if (status !== 'completed') return null;
  // `skipped` is not a failure and is not a success; reporting it as either
  // would put a step on the timeline that never ran.
  if (conclusion === 'skipped') return null;
  return conclusion === 'success' ? 'SUCCEEDED' : 'FAILED';
}
