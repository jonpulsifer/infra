/**
 * The values every deploy adapter constructs to speak §6's stream.
 *
 * Five adapters had each written the same `status`/`log`/`internal`/`clock`
 * trio privately, and that is not five decisions that happened to agree. §6's
 * timeline is one vocabulary the UI reads from every backend at once, so the
 * shape of a `log` event — down to whether an absent `resource` is an omitted
 * key or a `resource: undefined` — is a property of the contract rather than of
 * whichever backend produced the line.
 *
 * **A closure over the clock, not a base class.** Time is injected: a test
 * hands in a counter and reads the timeline back, and three of the adapters
 * count their own deadlines in the same time. So the clock has to travel with
 * the constructors, and the smallest thing that carries it is a closure. An
 * adapter holds one; nothing inherits, and every verb stays where it was.
 */
import type {
  DeployEvent,
  DeployPhase,
  DeployVerdict,
  FailureReason,
} from './contract.ts';

/** §6's event constructors, bound to one adapter's clock. */
export interface DeployEvents {
  /** That same clock, so a deadline is counted in the time the events wear. */
  now(): number;
  status(
    phase: DeployPhase,
    extra?: { resource?: string; reason?: FailureReason; detail?: string },
  ): DeployEvent;
  log(line: string, resource?: string): DeployEvent;
}

/**
 * Bind the constructors to a clock, falling back to the wall one.
 *
 * The parameter is the adapter's own `options.now`, passed rather than read:
 * this is called from a constructor body, and reaching back into the adapter
 * for the field would be the one ordering hazard a factory avoids.
 */
export function deployEvents(now?: () => number): DeployEvents {
  const clock = () => now?.() ?? Date.now();
  return {
    now: clock,
    status: (phase, extra = {}) => ({
      type: 'status',
      at: new Date(clock()),
      phase,
      ...extra,
    }),
    log: (line, resource) => ({
      type: 'log',
      at: new Date(clock()),
      line,
      ...(resource === undefined ? {} : { resource }),
    }),
  };
}

/**
 * The verdict for a fault that is Spindrift's own (§6's `INTERNAL`).
 *
 * No `ref`, and that is the whole reason this is one function rather than a
 * shape each adapter fills in: every use is a refusal taken *before* anything
 * was placed — a foreign artifact, a Target of the wrong type, a reach this
 * backend cannot serve — so there is no handle for core to store, and a
 * fabricated one would be a ref pointing at nothing.
 */
export function internalFailure(detail: string): DeployVerdict {
  return { phase: 'FAILED', reason: 'INTERNAL', detail };
}
