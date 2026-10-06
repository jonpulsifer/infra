import { describe, expect, test } from 'bun:test';
import { verdict } from '../../src/web/views/operations/overview.tsx';

function counts(overrides: Partial<Parameters<typeof verdict>[0]> = {}) {
  return {
    apps: 6,
    liveApps: 6,
    failedApps: 0,
    inFlightApps: 0,
    failedDeploys: 0,
    failedBuilds: 0,
    runningBuilds: 0,
    attentionTargets: 0,
    ...overrides,
  };
}

describe('what the banner says', () => {
  test('a healthy installation says so, and counts nothing at the reader', () => {
    const { headline, lede } = verdict(counts());
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('6 Apps are up');
  });

  test('an empty installation is onboarding, not a zero', () => {
    const { headline, lede } = verdict(counts({ apps: 0, liveApps: 0 }));
    expect(headline).toBe('Nothing is running yet.');
    expect(lede).toContain('Create an App');
  });

  test('one failing App is singular, several are plural', () => {
    expect(verdict(counts({ failedApps: 1, liveApps: 5 })).headline).toBe(
      'One App needs you.',
    );
    expect(verdict(counts({ failedApps: 3, liveApps: 3 })).headline).toBe(
      '3 Apps need you.',
    );
  });

  test('the red App says the previous release is still answering', () => {
    const { lede } = verdict(counts({ failedApps: 1, liveApps: 5 }));
    expect(lede).toContain('the one before it is still what answers');
  });
});

describe('which fact wins when several are true', () => {
  test('a failed App outranks anything in flight', () => {
    const both = verdict(
      counts({ failedApps: 1, liveApps: 4, inFlightApps: 1, runningBuilds: 2 }),
    );
    expect(both.headline).toBe('One App needs you.');
  });

  test('a failed App outranks an unhealthy Target', () => {
    const both = verdict(
      counts({ failedApps: 1, liveApps: 5, attentionTargets: 2 }),
    );
    expect(both.headline).toBe('One App needs you.');
  });

  test('an unhealthy Target is named even while everything serves', () => {
    const { headline, lede } = verdict(counts({ attentionTargets: 1 }));
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('1 Target needs attention');
  });

  test('and it is pluralised on its own count, not the App count', () => {
    expect(verdict(counts({ attentionTargets: 2 })).lede).toContain(
      '2 Targets need attention',
    );
  });

  test('work in flight is reported once everything standing is healthy', () => {
    const { headline, lede } = verdict(
      counts({ inFlightApps: 1, liveApps: 5, runningBuilds: 2 }),
    );
    expect(headline).toBe('All serving. Something shipping.');
    // In-flight Apps and running Builds count together.
    expect(lede).toContain('3 things are moving');
  });

  test('one moving thing is singular', () => {
    expect(verdict(counts({ inFlightApps: 1, liveApps: 5 })).lede).toContain(
      '1 thing is moving',
    );
  });

  test('failures behind the ledger never claim something is down', () => {
    // Failed Deploys with every App serving are what a rollback leaves behind.
    const { headline, lede } = verdict(
      counts({ failedDeploys: 4, failedBuilds: 2 }),
    );
    expect(headline).toBe('Everything is serving.');
    expect(lede).toContain('nothing that is failing is what answers a request');
  });
});

describe('the sentence is always a sentence', () => {
  test('every branch ends in a full stop and neither half is empty', () => {
    const cases = [
      counts({ apps: 0, liveApps: 0 }),
      counts(),
      counts({ failedApps: 1, liveApps: 5 }),
      counts({ failedApps: 2, liveApps: 4 }),
      counts({ attentionTargets: 1 }),
      counts({ inFlightApps: 1, liveApps: 5 }),
      counts({ runningBuilds: 1 }),
      counts({ failedDeploys: 1 }),
      counts({ failedBuilds: 1 }),
    ];
    for (const input of cases) {
      const { headline, lede } = verdict(input);
      expect(headline.length).toBeGreaterThan(0);
      expect(lede.length).toBeGreaterThan(0);
      expect(headline.endsWith('.')).toBe(true);
      expect(lede.endsWith('.')).toBe(true);
      expect(lede).not.toContain('undefined');
      expect(lede).not.toContain('NaN');
    }
  });
});
