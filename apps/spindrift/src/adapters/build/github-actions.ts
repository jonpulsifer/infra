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
  readonly destination: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  /** Pinned by the installation, never chosen by the runner. */
  readonly zeroConfigFrontend: string;
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

    // A repo App builds where its source lives, on its own minutes (§15); an
    // archive has no repository, so it builds where the workflow does.
    const repository =
      source.origin.type === 'repo'
        ? source.origin.repository
        : this.platformRepository;
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
      buildArgs: spec.buildArgs,
      zeroConfigFrontend: this.options.zeroConfigFrontend,
    };

    let ref: RepositoryRef;
    let branch: string;
    try {
      ref = await host.installationFor(repository);
      branch = (await host.repository(ref, repository)).defaultBranch;
      await host.dispatchWorkflow(ref, repository, {
        workflow,
        branch,
        inputs: { spec: JSON.stringify(request), correlation },
      });
    } catch (error) {
      // §4 story 48: a failure *before* the build step — dispatch refused, the
      // runner never came up — must be visible as text rather than as an empty
      // log and a spinner. So it is yielded onto the attempt log first and
      // becomes the verdict second.
      const detail = error instanceof Error ? error.message : String(error);
      yield { type: 'log', at: now(), line: `dispatch failed: ${detail}` };
      return buildFailed(
        logs,
        'TARGET_UNREACHABLE',
        `could not dispatch ${workflow} in ${repository}: ${detail}`,
        { repository, workflow },
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
