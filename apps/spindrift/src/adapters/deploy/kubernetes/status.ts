/**
 * A delivery object's status in deploy phases, so neither Flux's nor Argo's
 * vocabulary reaches core.
 */
import type { DeployPhase, FailureReason } from '../contract.ts';

export interface DeliveryStatus {
  phase: DeployPhase;
  /** Unset on `FAILED` when the object gives no cause; pods are read instead. */
  reason?: FailureReason;
  /** The sentence the developer reads, in the platform's own words. */
  detail?: string;
  /** The raw payload, kept for the operator. */
  debug?: unknown;
}
