/**
 * Tracks alert fingerprints already phoned in, so a repeated Alertmanager
 * notification for a still-firing alert does not ring twice. A resolved
 * alert clears its fingerprint, so a later re-fire pages again.
 */
export class FingerprintDedupe {
  private readonly seen = new Set<string>();

  isNew(fingerprint: string): boolean {
    return !this.seen.has(fingerprint);
  }

  markSeen(fingerprint: string): void {
    this.seen.add(fingerprint);
  }

  clear(fingerprint: string): void {
    this.seen.delete(fingerprint);
  }
}
