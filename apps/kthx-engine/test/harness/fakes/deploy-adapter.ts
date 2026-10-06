/** A `DeployAdapter` that records each call and replays scripted verdicts. */
import type {
  DeployAdapter,
  DeployEvent,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  JobExecution,
  JobRuns,
  ObservedState,
  Restarted,
  RunOptions,
  RuntimeLogPage,
  RuntimeLogSubject,
  RuntimeLogTailOptions,
  StartedRun,
} from '../../../src/adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../../src/config/manifest.schema.ts';
import {
  type Prerequisite,
  prerequisitesFor,
  type TargetDiscovery,
  type TargetInspection,
} from '../../../src/domain/capabilities.ts';
import type {
  ArtifactType,
  DesiredState,
} from '../../../src/domain/desired-state.ts';

export interface ScriptedAttempt {
  events?: readonly DeployEvent[];
  verdict: DeployVerdict;
}

export interface RecordedApply {
  target: DeployTarget;
  desired: DesiredState;
}

/** Each `*Throws` makes its method throw the message. */
export interface FakeDeployAdapterOptions {
  adapter?: TargetAdapter;
  artifactTypes?: readonly ArtifactType[];
  /** One entry per `apply`; the last repeats once the script runs out. */
  script?: readonly ScriptedAttempt[];
  /** Overrides on {@link CAPABLE_DISCOVERY} for what `inspect` reports. */
  discovery?: Partial<TargetDiscovery>;
  /** Checklist items to report unmet, with the sentence behind each. */
  unmet?: Readonly<Partial<Record<Prerequisite, string>>>;
  /** When set, `inspect` throws this message. */
  unreachable?: string;
  /**
   * When set, `inspect` reports the surface absent, as a project with the service
   * off does, and every prerequisite unmet with this detail.
   */
  surfaceAbsent?: string;
  /** The contract forbids `apply` from throwing, but a buggy adapter does. */
  applyThrows?: string;
  /** When set, `run`, `executions` and `restart` refuse with this. */
  noRuns?: string;
  runThrows?: string;
  restartThrows?: string;
  destroyThrows?: string;
  sweepThrows?: string;
  /** Fails reading runs while `run` works, as a Role without `list` does. */
  executionsThrows?: string;
}

/** Passes everything, so a test that excludes a Target names what it lacks. */
export const CAPABLE_DISCOVERY: TargetDiscovery = {
  arch: ['amd64', 'arm64'],
  gpu: false,
  resourceCeiling: { cpu: '8', memory: '32Gi' },
  persistence: true,
  postgres: true,
  valkey: true,
  egressFiltering: true,
  policyEngine: { installed: true, mode: 'ENFORCE' },
  logHistorySeconds: 7 * 24 * 60 * 60,
  servedHosts: [],
  reachableRegistries: [],
  reachableSecretStores: ['gcp-secret-manager'],
};

/** A fixed time for event stamps. */
const AT = new Date('2000-01-01T00:00:00.000Z');

const DEFAULT_ATTEMPT: ScriptedAttempt = {
  verdict: { phase: 'LIVE', ref: 'fake-deploy-1' },
};

export class FakeDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter;
  readonly artifactTypes: readonly ArtifactType[];

  readonly applied: RecordedApply[] = [];
  readonly destroyed: DeployRef[] = [];
  readonly swept: string[] = [];

  readonly inspected: DeployTarget[] = [];

  readonly runsStarted: DeployRef[] = [];
  readonly runsStartedWith: Readonly<Record<string, string>>[] = [];
  readonly restarted: DeployRef[] = [];

  private readonly script: readonly ScriptedAttempt[];
  private readonly options: FakeDeployAdapterOptions;
  private attempts = 0;
  /** What `observe` reports, set by `apply` or `place`. */
  private readonly placed = new Map<DeployRef, ObservedState>();
  /** Each ref's runs, oldest first. */
  private readonly runs = new Map<DeployRef, JobExecution[]>();

  constructor(options: FakeDeployAdapterOptions = {}) {
    this.options = options;
    this.adapter = options.adapter ?? 'kubernetes';
    this.artifactTypes = options.artifactTypes ?? ['image'];
    this.script = options.script?.length ? options.script : [DEFAULT_ATTEMPT];
  }

  /** Places a workload core never applied, as the far side reports it. */
  place(ref: DeployRef, state: ObservedState): void {
    this.placed.set(ref, state);
  }

  get placementCount(): number {
    return this.placed.size;
  }

  /** Merges into what later `inspect` calls report. */
  discover(discovery: Partial<TargetDiscovery>): void {
    this.options.discovery = { ...this.options.discovery, ...discovery };
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    this.applied.push({ target, desired });

    if (this.options.applyThrows !== undefined) {
      throw new Error(this.options.applyThrows);
    }

    // An undeclared artifact type is a core bug, answered as a `FAILED` verdict.
    if (!this.artifactTypes.includes(desired.artifact.type)) {
      const verdict: DeployVerdict = {
        phase: 'FAILED',
        reason: 'INTERNAL',
        detail: `${this.adapter} does not accept a ${desired.artifact.type} artifact`,
      };
      yield { type: 'status', at: AT, phase: 'FAILED', reason: 'INTERNAL' };
      return verdict;
    }

    const attempt = this.nextAttempt();
    for (const event of attempt.events ?? []) yield event;

    if (attempt.verdict.phase === 'LIVE') {
      this.placed.set(attempt.verdict.ref, {
        ref: attempt.verdict.ref,
        phase: 'LIVE',
        artifactDigest: desired.artifact.digest,
      });
    }
    return attempt.verdict;
  }

  async observe(
    _target: DeployTarget,
    ref: DeployRef,
  ): Promise<ObservedState | null> {
    return this.placed.get(ref) ?? null;
  }

  async destroy(_target: DeployTarget, ref: DeployRef): Promise<void> {
    this.destroyed.push(ref);
    if (this.options.destroyThrows !== undefined) {
      throw new Error(this.options.destroyThrows);
    }
    this.placed.delete(ref);
  }

  async sweepApp(_target: DeployTarget, app: string): Promise<void> {
    this.swept.push(app);
    if (this.options.sweepThrows !== undefined) {
      throw new Error(this.options.sweepThrows);
    }
  }

  /** Records a run core never started, as a scheduler would. */
  ran(ref: DeployRef, execution: JobExecution): void {
    this.runs.set(ref, [...(this.runs.get(ref) ?? []), execution]);
  }

  async run(
    _target: DeployTarget,
    ref: DeployRef,
    options: RunOptions = {},
  ): Promise<StartedRun> {
    this.runsStarted.push(ref);
    this.runsStartedWith.push(options.env ?? {});
    if (this.options.runThrows !== undefined) {
      throw new Error(this.options.runThrows);
    }
    const refusal = this.refusalFor(ref);
    if (refusal !== null) return refusal;
    // Names only, never values, as real adapters report a run's parameters.
    const names = Object.keys(options.env ?? {});
    const execution: JobExecution = {
      name: `${ref}-run-${(this.runs.get(ref)?.length ?? 0) + 1}`,
      outcome: 'running',
      startedAt: null,
      ...(names.length === 0 ? {} : { detail: `ran with ${names.join(', ')}` }),
    };
    this.ran(ref, execution);
    return { kind: 'started', execution };
  }

  /** The detail counts restarts per ref, so a test can tell two presses apart. */
  async restart(_target: DeployTarget, ref: DeployRef): Promise<Restarted> {
    this.restarted.push(ref);
    if (this.options.restartThrows !== undefined) {
      throw new Error(this.options.restartThrows);
    }
    if (this.options.noRuns !== undefined) {
      return { kind: 'none', because: this.options.noRuns };
    }
    if (!this.placed.has(ref)) {
      return { kind: 'none', because: `nothing is placed under ${ref}` };
    }
    const count = this.restarted.filter((seen) => seen === ref).length;
    return { kind: 'restarted', detail: `restart ${count} of ${ref}` };
  }

  async executions(_target: DeployTarget, ref: DeployRef): Promise<JobRuns> {
    if (this.options.executionsThrows !== undefined) {
      throw new Error(this.options.executionsThrows);
    }
    const refusal = this.refusalFor(ref);
    if (refusal !== null) return refusal;
    return {
      kind: 'executions',
      executions: [...(this.runs.get(ref) ?? [])].reverse(),
    };
  }

  async tail(
    _target: DeployTarget,
    _subject: RuntimeLogSubject,
    options: RuntimeLogTailOptions = {},
  ): Promise<RuntimeLogPage> {
    return {
      kind: 'stream',
      entries: [],
      cursor: options.after ?? null,
      reach: CAPABLE_DISCOVERY.logHistorySeconds,
    };
  }

  async inspect(target: DeployTarget): Promise<TargetInspection> {
    this.inspected.push(target);
    if (this.options.unreachable !== undefined) {
      throw new Error(this.options.unreachable);
    }
    const absent = this.options.surfaceAbsent;
    const unmet = this.options.unmet ?? {};
    return {
      prerequisites: prerequisitesFor(this.adapter).map((name) =>
        absent !== undefined
          ? { name, met: false, detail: absent }
          : unmet[name] === undefined
            ? { name, met: true }
            : { name, met: false, detail: unmet[name] },
      ),
      discovery: { ...CAPABLE_DISCOVERY, ...this.options.discovery },
      surface:
        absent === undefined
          ? { kind: 'carried' }
          : { kind: 'absent', detail: absent },
    };
  }

  /** Shared by `run` and `executions`, so no run starts that cannot be listed. */
  private refusalFor(
    ref: DeployRef,
  ): Extract<JobRuns, { kind: 'none' }> | null {
    if (this.options.noRuns !== undefined) {
      return { kind: 'none' as const, because: this.options.noRuns };
    }
    if (!this.placed.has(ref) && !this.runs.has(ref)) {
      return {
        kind: 'none' as const,
        because: `nothing is placed under ${ref}`,
      };
    }
    return null;
  }

  private nextAttempt(): ScriptedAttempt {
    const index = Math.min(this.attempts, this.script.length - 1);
    this.attempts += 1;
    return this.script[index] ?? DEFAULT_ATTEMPT;
  }
}
