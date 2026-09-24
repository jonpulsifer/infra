/**
 * Event and verdict constructors every deploy adapter shares, bound to an
 * injected clock so tests control time and deadlines count in the same time.
 */
import type {
  DeployEvent,
  DeployPhase,
  DeployVerdict,
  FailureReason,
} from './contract.ts';

export interface DeployEvents {
  /** The events' clock, so deadlines count in the same time. */
  now(): number;
  status(
    phase: DeployPhase,
    extra?: { resource?: string; reason?: FailureReason; detail?: string },
  ): DeployEvent;
  log(line: string, resource?: string): DeployEvent;
}

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

/** No `ref`: every caller refuses before anything is placed. */
export function internalFailure(detail: string): DeployVerdict {
  return { phase: 'FAILED', reason: 'INTERNAL', detail };
}
