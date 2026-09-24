export interface AlertmanagerAlert {
  readonly status?: string;
  readonly labels?: Record<string, string>;
  readonly fingerprint?: string;
}

export interface FiringAlert extends AlertmanagerAlert {
  readonly fingerprint: string;
}

export interface AlertmanagerPayload {
  readonly status?: string;
  readonly alerts?: readonly AlertmanagerAlert[];
}

function alerts(payload: AlertmanagerPayload): readonly AlertmanagerAlert[] {
  return Array.isArray(payload.alerts) ? payload.alerts : [];
}

/**
 * Firing, `severity: critical`, and never the synthetic `Watchdog` alert that
 * a cluster fires continuously to prove the alerting pipeline is alive.
 */
export function criticalFiringAlerts(
  payload: AlertmanagerPayload,
): FiringAlert[] {
  return alerts(payload).filter(
    (a): a is FiringAlert =>
      a.status === 'firing' &&
      a.labels?.severity === 'critical' &&
      a.labels?.alertname !== 'Watchdog' &&
      typeof a.fingerprint === 'string',
  );
}

export function resolvedFingerprints(payload: AlertmanagerPayload): string[] {
  return alerts(payload)
    .filter((a) => a.status === 'resolved' && typeof a.fingerprint === 'string')
    .map((a) => a.fingerprint as string);
}
