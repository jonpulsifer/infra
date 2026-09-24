/**
 * The hosted-CI build route: dispatches a caller workflow, finds the run by the
 * correlation it writes into the run name, and reads the report from the run's
 * log.
 */

import type { RegistryFlavour } from '../../domain/artifact-name.ts';
import type { RepositoryRef } from '../../domain/repository.ts';
import {
  CALLER_WORKFLOW_FILE,
  RUN_NAME_PREFIX,
} from '../../integrations/github/config-pr.ts';
import type {
  BuildAdapter,
  BuildEvent,
  BuildHandle,
  BuildLevel,
  BuildResult,
  BuildSource,
  BuildSpec,
  LogFidelity,
} from './contract.ts';
import type { BuildRouteDescriptor } from './descriptor.ts';
import { parseBuildReport } from './report.ts';
import {
  buildFailed,
  buildSucceeded,
  DEFAULT_BUILD_TIMEOUT_MS,
  deadlineFrom,
  type PollingOptions,
} from './route.ts';

export interface ActionsRun {
  readonly id: number;
  /** The `run-name` the caller stamped, which is how a run is correlated. */
  readonly name: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  /** Nullable, because the route never composes a run URL the host did not report. */
  readonly htmlUrl: string | null;
}

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

/** The GitHub calls this route makes. */
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
  /** Stop a run. One that already concluded is left as it is. */
  cancelRun(ref: RepositoryRef, fullName: string, runId: number): Promise<void>;
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
   * The reusable workflow, `owner/repo/.github/workflows/<file>@<ref>`. Only its
   * repository is read; the dispatched caller workflow's `uses:` pins the ref.
   */
  readonly buildWorkflow: string;
  readonly zeroConfigFrontend: string;
  readonly signer: string;
  readonly attestor: string;
  /** SPKI PEM, the manifest's `sealPublicKey`. Setting it turns on `carriesHeldSecret`. */
  readonly sealPublicKey?: string;
  readonly correlation?: () => string;
  /** How long to keep looking for the run a dispatch started. */
  readonly discoveryMs?: number;
}

/** Throws, because the manifest schema already refuses any other shape. */
export function reusableWorkflowRepository(reference: string): string {
  const match = /^([^/@\s]+\/[^/@\s]+)\/\.github\/workflows\/[^@\s]+@/.exec(
    reference,
  );
  if (match === null) {
    throw new TypeError(`not a reusable workflow reference: ${reference}`);
  }
  return match[1] as string;
}

/** The `spec` input the reusable workflow reads. */
export interface BuildRequestSpec {
  readonly bundleDigest: string;
  readonly origin: BuildSource['origin'];
  readonly artifactType: BuildSpec['artifactType'];
  readonly kind: BuildSpec['kind'];
  readonly platform: BuildSpec['platform'];
  readonly destinations: readonly string[];
  /** The workflow tags with these and no others. */
  readonly tags: readonly string[];
  readonly buildArgs: Readonly<Record<string, string>>;
  /** See {@link BuildSpec.outputDirectory}. The workflow reads absent as `null`. */
  readonly outputDirectory: string | null;
  /** See {@link BuildSpec.vercelFramework}. Always set for a `vercel-output` build. */
  readonly vercelFramework: string | null;
  /** Pinned by the installation, never chosen by the runner. */
  readonly zeroConfigFrontend: string;
  /**
   * The installation's signing key. The runner also signs the digest in the
   * registry, where a cluster's admission reads signatures; core cannot push there.
   */
  readonly signer: string;
  /**
   * `projects/<project>/attestors/<name>`, or empty. Binary Authorization reads
   * an attestation in the attestor's project, which no registry signature replaces.
   */
  readonly attestor: string;
  /**
   * The held registry credentials sealed by `sealForRun`, absent when
   * `registryAuth` is empty. The run header shows dispatch inputs in the clear.
   */
  readonly sealedRegistryAuth?: string;
  /** The build secrets, sealed the same way; absent when there are none. */
  readonly sealedBuildSecrets?: string;
}

export class GitHubActionsBuildRoute implements BuildAdapter {
  readonly name: string;
  /** A hosted runner shows step transitions live and the log text at the end. */
  readonly logFidelity: LogFidelity = 'LIVE_STATUS';
  readonly provenanceBuilderId =
    'https://github.com/actions/runner/github-hosted';
  /**
   * Only with a seal key. The run header shows dispatch inputs, so held secrets
   * travel sealed, and the workflow opens them with the matching private key.
   */
  readonly carriesHeldSecret: boolean;
  /**
   * The run logs in to GHCR with its own token and federates into the artifact
   * registry.
   */
  readonly selfAuthorizedRegistries: readonly RegistryFlavour[] = [
    'ghcr',
    'artifactRegistry',
  ];
  /**
   * L2: the workflow runs with the connected repository's permissions, so that
   * repository's maintainers can reach the build.
   */
  readonly buildLevel: BuildLevel = 2;

  /** Where an archive builds, having no repository of its own. */
  private readonly platformRepository: string;

  constructor(private readonly options: GitHubActionsRouteOptions) {
    this.name = options.name;
    this.platformRepository = reusableWorkflowRepository(options.buildWorkflow);
    this.carriesHeldSecret = options.sealPublicKey !== undefined;
  }

  /** The URL the host reported names the run's repository and id. */
  async cancel(handle: BuildHandle): Promise<void> {
    const run = runAt(handle.runUrl);
    if (run === null) {
      throw new Error(
        'the host reported no address for this run, so there is nothing to cancel it by',
      );
    }
    const ref = await this.options.host.installationFor(run.repository);
    await this.options.host.cancelRun(ref, run.repository, run.id);
  }

  async *build(
    source: BuildSource,
    spec: BuildSpec,
    dispatchId?: string,
  ): AsyncGenerator<BuildEvent, BuildResult, void> {
    const now = this.options.now ?? (() => new Date());
    const logs = { backend: this.name, fidelity: this.logFidelity } as const;
    const { host } = this.options;

    // A repo App builds on its own repository's minutes, else on the platform
    // repository's. The runner fetches the staged bundle, so the build is the same.
    const candidates =
      source.origin.type === 'repo' &&
      source.origin.repository !== this.platformRepository
        ? [source.origin.repository, this.platformRepository]
        : [this.platformRepository];
    // A caller workflow in either repository, with the same file name and inputs.
    const workflow = CALLER_WORKFLOW_FILE;

    // The dispatch id where there is one, so the run name says which attempt it is.
    const correlation =
      dispatchId ?? (this.options.correlation ?? (() => crypto.randomUUID()))();
    const runName = `${RUN_NAME_PREFIX} ${correlation}`;

    // Dispatch already refused a held secret without a seal key, so reaching the
    // throw below is a programming error.
    let sealedRegistryAuth: string | undefined;
    let sealedBuildSecrets: string | undefined;
    if (spec.registryAuth.length > 0 || spec.buildSecrets.length > 0) {
      if (this.options.sealPublicKey === undefined) {
        throw new TypeError(
          'build received a held secret but this route has no sealPublicKey configured',
        );
      }
      if (spec.registryAuth.length > 0) {
        sealedRegistryAuth = await sealForRun(
          spec.registryAuth,
          this.options.sealPublicKey,
        );
      }
      if (spec.buildSecrets.length > 0) {
        sealedBuildSecrets = await sealForRun(
          spec.buildSecrets,
          this.options.sealPublicKey,
        );
      }
    }

    const request: BuildRequestSpec = {
      bundleDigest: source.bundleDigest,
      origin: source.origin,
      artifactType: spec.artifactType,
      kind: spec.kind,
      platform: spec.platform,
      destinations: spec.destinations,
      tags: spec.tags,
      buildArgs: spec.buildArgs,
      outputDirectory: spec.outputDirectory,
      vercelFramework: spec.vercelFramework,
      zeroConfigFrontend: this.options.zeroConfigFrontend,
      signer: this.options.signer,
      attestor: this.options.attestor,
      ...(sealedRegistryAuth !== undefined ? { sealedRegistryAuth } : {}),
      ...(sealedBuildSecrets !== undefined ? { sealedBuildSecrets } : {}),
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
        // Every failed attempt is logged, which explains a run in the platform
        // repository.
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
      timeoutMs:
        this.options.discoveryMs ??
        this.options.timeoutMs ??
        DEFAULT_BUILD_TIMEOUT_MS,
    });
    let run: ActionsRun | null = null;
    // The dispatch succeeded, so a failed lookup is retried until the discovery
    // deadline, which then blames the last lookup failure.
    let lookupFailure: string | null = null;
    while (run === null) {
      if (discovery.expired()) {
        const complaint =
          lookupFailure === null
            ? `no run named “${runName}” appeared in ${repository}`
            : `the lookup for run “${runName}” in ${repository} kept failing: ${lookupFailure}`;
        yield { type: 'log', at: now(), line: complaint };
        return buildFailed(
          logs,
          'TARGET_UNREACHABLE',
          `the workflow was dispatched but ${complaint}`,
          { repository, workflow, runName },
        );
      }
      await discovery.tick();
      try {
        const runs = await host.workflowRuns(ref, repository, {
          workflow,
          branch,
        });
        run = runs.find((candidate) => candidate.name === runName) ?? null;
        lookupFailure = null;
      } catch (error) {
        lookupFailure = error instanceof Error ? error.message : String(error);
        yield {
          type: 'log',
          at: now(),
          line: `the dispatch succeeded and the lookup for its run did not; retrying: ${lookupFailure}`,
        };
      }
    }

    yield { type: 'log', at: now(), line: `run ${run.id} started` };

    // Yielded as soon as the run is found, since at `LIVE_STATUS` the live text
    // is only on the host's page. A missing or empty URL yields nothing.
    if (run.htmlUrl) {
      yield { type: 'runner', at: now(), url: run.htmlUrl };
    }

    const budget = deadlineFrom(this.options);
    const seen = new Set<string>();
    let conclusion: string | null = null;
    let jobs: readonly ActionsJob[] = [];

    for (;;) {
      try {
        jobs = await host.runJobs(ref, repository, run.id);
        for (const event of stepEvents(jobs, seen, now())) yield event;

        const current = await host.workflowRun(ref, repository, run.id);
        if (current !== null && current.status === 'completed') {
          conclusion = current.conclusion;
          break;
        }
      } catch (error) {
        // The run exists, so a failed status read is retried within the budget.
        const detail = error instanceof Error ? error.message : String(error);
        yield {
          type: 'log',
          at: now(),
          line: `the status of run ${run.id} could not be read; retrying: ${detail}`,
        };
      }
      if (budget.expired()) {
        // Best-effort: the Build fails either way, and the host's limit ends the run.
        yield {
          type: 'log',
          at: now(),
          line: `run ${run.id} did not finish within the build budget; cancelling it`,
        };
        await host.cancelRun(ref, repository, run.id).catch(() => {});
        return buildFailed(
          logs,
          'TIMEOUT',
          `run ${run.id} in ${repository} did not finish within the build budget`,
          { runId: run.id },
        );
      }
      await budget.tick();
    }

    // Read on red runs too: the failure is in the log.
    let log = '';
    for (const job of jobs) {
      let text: string | null;
      try {
        text = await host.jobLog(ref, repository, job.id);
      } catch (error) {
        // The report rides the log, so an unreadable log fails the build. The
        // dispatch worked and the developer is not at fault.
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

    if (conclusion === 'cancelled') {
      // Cancelled by this route's budget or an operator. `TIMEOUT` blames nobody.
      return buildFailed(
        logs,
        'TIMEOUT',
        `run ${run.id} in ${repository} was cancelled`,
        { runId: run.id, conclusion },
      );
    }

    if (conclusion !== 'success') {
      const scaffolding = failedScaffoldingStep(jobs);
      if (scaffolding !== null) {
        return buildFailed(
          logs,
          // The platform's own preamble failed before the developer's code ran.
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
      // A green run with no report ran something else; the developer is not at fault.
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
 * Seals a payload for the dispatch inputs. AES-256-GCM encrypts it and RSA-OAEP
 * wraps the key, since OAEP alone holds a few hundred bytes. The envelope is
 * `base64(JSON.stringify({k, iv, c}))`, which the workflow's seal steps decode.
 */
export async function sealForRun(
  payload: unknown,
  sealPublicKey: string,
): Promise<string> {
  const publicKey = await crypto.subtle.importKey(
    'spki',
    spkiPemToDer(sealPublicKey),
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );

  const aesKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const rawKey = await crypto.subtle.exportKey('raw', aesKey);
  const wrappedKey = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    publicKey,
    rawKey,
  );

  const envelope = {
    k: Buffer.from(wrappedKey).toString('base64'),
    iv: Buffer.from(iv).toString('base64'),
    c: Buffer.from(ciphertext).toString('base64'),
  };
  return Buffer.from(JSON.stringify(envelope)).toString('base64');
}

/** The DER bytes inside an SPKI PEM, which is what WebCrypto's `importKey` takes. */
function spkiPemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-{5}BEGIN PUBLIC KEY-{5}/, '')
    .replace(/-{5}END PUBLIC KEY-{5}/, '')
    .replace(/\s+/g, '');
  // A fresh `Uint8Array<ArrayBuffer>`: WebCrypto's `BufferSource` rejects the
  // `ArrayBufferLike` that `Buffer`'s type admits.
  return new Uint8Array(Buffer.from(body, 'base64'));
}

/**
 * The workflow step that compiles the App's code, which separates a developer
 * failure from a platform one. It must match the step name in the workflow.
 */
export const DEVELOPER_BUILD_STEP = 'Build and push';

/** The repository and run id in a run's `html_url`, or `null`. */
function runAt(
  url: string | null,
): { readonly repository: string; readonly id: number } | null {
  if (url === null) return null;
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /^\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/|$)/.exec(
    pathname,
  );
  if (match === null) return null;
  return { repository: match[1] as string, id: Number(match[2]) };
}

/**
 * The platform step a red run failed in, or `null` when the App's build step
 * failed or no step reported a failure.
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

/** Step transitions not yet yielded. The jobs endpoint repeats finished steps. */
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

/** A step's state, or `null` for one that has not started. */
function stepState(
  status: string,
  conclusion: string | null,
): 'RUNNING' | 'SUCCEEDED' | 'FAILED' | null {
  if (status === 'in_progress') return 'RUNNING';
  if (status !== 'completed') return null;
  // A skipped step never ran, so it gets no timeline entry.
  if (conclusion === 'skipped') return null;
  return conclusion === 'success' ? 'SUCCEEDED' : 'FAILED';
}

import { githubActionsConfigSchema } from '../../config/build-route-schemas.ts';

export const githubActionsDescriptor = {
  kind: 'github-actions',
  displayName: 'GitHub Actions',
  logo: 'github',
  buildLevel: 2,
  configSchema: githubActionsConfigSchema,
  create(config, context) {
    const workflow = context.manifest.github.buildWorkflow;
    if (context.app === null || workflow === null) return null;
    return new GitHubActionsBuildRoute({
      name: config.name,
      host: context.app,
      buildWorkflow: workflow,
      zeroConfigFrontend: context.manifest.build.zeroConfigFrontend,
      signer: context.manifest.supplyChain.signer,
      attestor: context.manifest.supplyChain.attestor ?? '',
      sealPublicKey: config.sealPublicKey,
    });
  },
} satisfies BuildRouteDescriptor;
