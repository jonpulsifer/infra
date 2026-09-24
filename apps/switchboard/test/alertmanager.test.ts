import { describe, expect, test } from 'bun:test';
import {
  type AlertmanagerPayload,
  criticalFiringAlerts,
  resolvedFingerprints,
} from '../src/alertmanager.ts';

function alert(overrides: {
  status?: string;
  severity?: string;
  alertname?: string;
  fingerprint?: string;
}) {
  return {
    status: overrides.status ?? 'firing',
    labels: {
      severity: overrides.severity ?? 'critical',
      alertname: overrides.alertname ?? 'PodCrashLooping',
    },
    fingerprint: overrides.fingerprint ?? 'fp1',
  };
}

describe('criticalFiringAlerts', () => {
  test('keeps only firing, critical alerts', () => {
    const payload: AlertmanagerPayload = {
      alerts: [
        alert({}),
        alert({ status: 'resolved', fingerprint: 'fp-resolved' }),
        alert({ severity: 'warning', fingerprint: 'fp-warning' }),
      ],
    };
    expect(criticalFiringAlerts(payload).map((a) => a.fingerprint)).toEqual([
      'fp1',
    ]);
  });

  test('never pages on the Watchdog alert', () => {
    const payload: AlertmanagerPayload = {
      alerts: [alert({ alertname: 'Watchdog' })],
    };
    expect(criticalFiringAlerts(payload)).toEqual([]);
  });

  test('an alert with no fingerprint is dropped', () => {
    const payload: AlertmanagerPayload = {
      alerts: [{ status: 'firing', labels: { severity: 'critical' } }],
    };
    expect(criticalFiringAlerts(payload)).toEqual([]);
  });

  test('a missing or malformed alerts field is empty, never a throw', () => {
    expect(criticalFiringAlerts({})).toEqual([]);
    expect(
      criticalFiringAlerts({
        alerts: 'nope',
      } as unknown as AlertmanagerPayload),
    ).toEqual([]);
  });
});

describe('resolvedFingerprints', () => {
  test('lists only the resolved fingerprints', () => {
    const payload: AlertmanagerPayload = {
      alerts: [
        alert({ fingerprint: 'still-firing' }),
        alert({ status: 'resolved', fingerprint: 'now-resolved' }),
      ],
    };
    expect(resolvedFingerprints(payload)).toEqual(['now-resolved']);
  });
});
