/**
 * A fake deploy backend (Task 7).
 *
 * § Testing: **"Fake the far side, not our side."** This sits exactly at the
 * adapter contract — it is the cluster that is not there, never a stand-in for
 * anything inside core. Core runs for real against it.
 *
 * It does two things a real backend cannot be asked to do on demand: it
 * **records** the {@link DesiredState} it was handed, so a test can assert what
 * core described, and it **replays a scripted verdict sequence**, so a test can
 * drive any phase progression or failure reason §6 names without arranging a
 * real cluster to misbehave.
 */
import type {
  DeployAdapter,
  DeployEvent,
  DeployRef,
  DeployTarget,
  DeployVerdict,
  JobExecution,
  JobRuns,
  ObservedState,
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

/** One scripted attempt: what to yield along the way, and how it ends. */
export interface ScriptedAttempt {
  events?: readonly DeployEvent[];
  verdict: DeployVerdict;
}

/** What the fake was asked to do, in order. */
export interface RecordedApply {
  target: DeployTarget;
  desired: DesiredState;
}

export interface FakeDeployAdapterOptions {
  adapter?: TargetAdapter;
  artifactTypes?: readonly ArtifactType[];
  /**
   * One entry per `apply` call. When the script runs out the fake keeps
   * replaying its last entry rather than throwing, so a test that only cares
   * about the first attempt does not have to script the rest.
   */
  script?: readonly ScriptedAttempt[];
  /**
   * What `inspect` reports. Partial: whatever is not overridden comes from
   * {@link CAPABLE_DISCOVERY}, so a test that cares about one capability says
   * one thing rather than restating the other ten.
   */
  discovery?: Partial<TargetDiscovery>;
  /** Checklist items to report unmet, with the sentence behind each. */
  unmet?: Readonly<Partial<Record<Prerequisite, string>>>;
  /** When set, `inspect` throws — the Target that cannot be reached at all. */
  unreachable?: string;
  /**
   * When set, `apply` throws instead of returning a verdict.
   *
   * §6 contracts `apply` not to throw — "an adapter that cannot place the
   * workload says so as a `FAILED` verdict, because a thrown error has no reason
   * and therefore no blame" — but an adapter is code, and code has bugs. Core
   * has to survive one, so the fake has to be able to be one.
   */
  applyThrows?: string;
  /**
   * When set, both run verbs refuse with this sentence — the `static` shape.
   *
   * §17 gives a backend that runs nothing an explicit refusal rather than an
   * empty list, so a test about how core handles one needs a fake that can be
   * that backend without being a different class.
   */
  noRuns?: string;
  /** When set, `run` throws — the far side that was asked correctly and failed. */
  runThrows?: string;
  /**
   * When set, `executions` throws while `run` still works.
   *
   * Separate from {@link runThrows} because that is the state this feature's
   * first day looks like: `list` on batch jobs is a grant the Role has not
   * reconciled yet, so reading the runs `403`s while starting one would have
   * worked. A fake that could only fail both could not tell whether core hid
   * the button because the job is unrunnable or because nobody could look.
   */
  executionsThrows?: string;
}

/**
 * A Target that passes everything. The fake's default is deliberately capable,
 * so a placement test that wants a Target excluded has to say which capability
 * it is missing — an inert default would exclude Targets for reasons the test
 * never stated.
 */
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

/** A clock the fake stamps events with, so a test's assertions stay stable. */
const AT = new Date('2000-01-01T00:00:00.000Z');

const DEFAULT_ATTEMPT: ScriptedAttempt = {
  verdict: { phase: 'LIVE', ref: 'fake-deploy-1' },
};

export class FakeDeployAdapter implements DeployAdapter {
  readonly adapter: TargetAdapter;
  readonly artifactTypes: readonly ArtifactType[];

  /** Every `apply`, in call order — the assertion surface §Testing asks for. */
  readonly applied: RecordedApply[] = [];
  /** Every `destroy`, including the repeats that prove idempotence. */
  readonly destroyed: DeployRef[] = [];

  /** Every `inspect`, so a test can prove the loop ran without a reconnect. */
  readonly inspected: DeployTarget[] = [];

  /** Every `run`, in call order — what proves a press reached the backend. */
  readonly runsStarted: DeployRef[] = [];

  private readonly script: readonly ScriptedAttempt[];
  private readonly options: FakeDeployAdapterOptions;
  private attempts = 0;
  /** What `apply` placed, so `observe` can report it back (§6). */
  private readonly placed = new Map<DeployRef, ObservedState>();
  /** The runs each ref has had, oldest first — the platform's own history. */
  private readonly runs = new Map<DeployRef, JobExecution[]>();

  constructor(options: FakeDeployAdapterOptions = {}) {
    this.options = options;
    this.adapter = options.adapter ?? 'kubernetes';
    this.artifactTypes = options.artifactTypes ?? ['image'];
    this.script = options.script?.length ? options.script : [DEFAULT_ATTEMPT];
  }

  /**
   * Put a workload on the far side that this fake did not place.
   *
   * What `observe` reports has to be arrangeable independently of `apply`, or
   * "the adapter is the authority on what is running, not core's memory" is
   * untestable — the only way to tell the two apart is a workload core never
   * saw placed.
   */
  place(ref: DeployRef, state: ObservedState): void {
    this.placed.set(ref, state);
  }

  /** Change what the next `inspect` reports — a capability flip, mid-test. */
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

    // An artifact type this backend never declared is a core bug, and §6 says
    // so in the adapter's own vocabulary rather than by throwing.
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
    this.placed.delete(ref);
  }

  /**
   * Put a run on the far side that this fake did not start.
   *
   * The same reason {@link place} exists: a job's history is the platform's,
   * and most of it was written by the scheduler rather than by anything core
   * asked for — so a test about reading runs has to be able to arrange runs
   * without pressing the button first.
   */
  ran(ref: DeployRef, execution: JobExecution): void {
    this.runs.set(ref, [...(this.runs.get(ref) ?? []), execution]);
  }

  async run(_target: DeployTarget, ref: DeployRef): Promise<StartedRun> {
    this.runsStarted.push(ref);
    if (this.options.runThrows !== undefined) {
      throw new Error(this.options.runThrows);
    }
    const refusal = this.refusalFor(ref);
    if (refusal !== null) return refusal;
    const execution: JobExecution = {
      name: `${ref}-run-${(this.runs.get(ref)?.length ?? 0) + 1}`,
      outcome: 'running',
      startedAt: null,
    };
    this.ran(ref, execution);
    return { kind: 'started', execution };
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
      // §13's "connect always succeeds" is core's promise, not the adapter's:
      // the adapter is allowed to fail, and core has to survive it.
      throw new Error(this.options.unreachable);
    }
    const unmet = this.options.unmet ?? {};
    return {
      prerequisites: prerequisitesFor(this.adapter).map((name) =>
        unmet[name] === undefined
          ? { name, met: true }
          : { name, met: false, detail: unmet[name] },
      ),
      discovery: { ...CAPABLE_DISCOVERY, ...this.options.discovery },
    };
  }

  /**
   * Why this ref has no runs, or `null` when it has.
   *
   * A ref nothing was placed under refuses for the same reason `observe`
   * returns `null` for one: the far side does not have it. Both run verbs share
   * the answer so a test cannot arrange a fake that would start a run it could
   * never then list.
   */
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

  /** The last scripted attempt repeats once the script is exhausted. */
  private nextAttempt(): ScriptedAttempt {
    const index = Math.min(this.attempts, this.script.length - 1);
    this.attempts += 1;
    return this.script[index] ?? DEFAULT_ATTEMPT;
  }
}
