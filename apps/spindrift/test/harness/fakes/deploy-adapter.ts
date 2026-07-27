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
  ObservedState,
} from '../../../src/adapters/deploy/contract.ts';
import type { TargetAdapter } from '../../../src/config/manifest.schema.ts';
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
}

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

  private readonly script: readonly ScriptedAttempt[];
  private attempts = 0;
  /** What `apply` placed, so `observe` can report it back (§6). */
  private readonly placed = new Map<DeployRef, ObservedState>();

  constructor(options: FakeDeployAdapterOptions = {}) {
    this.adapter = options.adapter ?? 'kubernetes';
    this.artifactTypes = options.artifactTypes ?? ['image'];
    this.script = options.script?.length ? options.script : [DEFAULT_ATTEMPT];
  }

  async *apply(
    target: DeployTarget,
    desired: DesiredState,
  ): AsyncGenerator<DeployEvent, DeployVerdict, void> {
    this.applied.push({ target, desired });

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

  /** The last scripted attempt repeats once the script is exhausted. */
  private nextAttempt(): ScriptedAttempt {
    const index = Math.min(this.attempts, this.script.length - 1);
    this.attempts += 1;
    return this.script[index] ?? DEFAULT_ATTEMPT;
  }
}
