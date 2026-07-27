/**
 * What a delivery object says, in §6's vocabulary rather than its own.
 *
 * The two flavours report differently — Flux writes conditions, Argo writes a
 * health and a sync status — and neither vocabulary may reach core: §6 gives
 * the user **one shared vocabulary** along one timeline. So each flavour
 * translates into this shape, and everything above it reads only this.
 *
 * A `reason` left unset on a `FAILED` is not an omission. It is the signal that
 * the delivery object knows the release failed but not why, which is exactly
 * when §6 says to read pods and events **once** and fill in the detail.
 */
import type { DeployPhase, FailureReason } from '../contract.ts';

export interface DeliveryStatus {
  phase: DeployPhase;
  reason?: FailureReason;
  /** The sentence the developer reads, in the platform's own words. */
  detail?: string;
  /** The raw payload, kept for the operator (§6). */
  debug?: unknown;
}
